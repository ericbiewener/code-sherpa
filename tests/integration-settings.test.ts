import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ClaudeAdapter } from '../src/main/agents/claude'
import { CodexAdapter } from '../src/main/agents/codex'
import { PiAdapter } from '../src/main/agents/pi'
import type { AgentEvent, AgentSettings, Session } from '../src/shared/types'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const clean of cleanup.splice(0)) await clean()
})

async function setup(settings: AgentSettings, resumeId?: string) {
  const directory = await mkdtemp(join(tmpdir(), 'sherpa-settings-'))
  const argvFile = join(directory, 'argv.json')
  const traceFile = join(directory, 'trace.jsonl')
  const fixture = resolve('tests/fixtures/agent.mjs')
  await chmod(fixture, 0o755)
  const session: Session = {
    id: 'test',
    title: 'Test',
    harness: settings.harness,
    settings,
    cwd: directory,
    resumeId,
    model: 'previously-observed-model',
    status: 'idle',
    createdAt: 0,
    updatedAt: 0,
    messages: [],
    interactions: [],
  }
  const events: AgentEvent[] = []
  const Adapter = { codex: CodexAdapter, claude: ClaudeAdapter, pi: PiAdapter }[settings.harness]
  const adapter = new Adapter({
    session,
    executable: fixture,
    env: { ...process.env, SHERPA_FIXTURE_ARGV: argvFile, SHERPA_FIXTURE_TRACE: traceFile },
    emit: (event) => events.push(event),
  })
  cleanup.push(async () => {
    adapter.dispose()
    await rm(directory, { recursive: true, force: true })
  })
  await adapter.start()
  return {
    adapter,
    events,
    directory,
    argv: async (): Promise<string[]> => JSON.parse(await readFile(argvFile, 'utf8')),
    trace: async () =>
      (await readFile(traceFile, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
  }
}

it.each([undefined, 'existing-thread'])(
  'passes only selected Codex options to thread start/resume (%s)',
  async (resumeId) => {
    const configured = await setup(
      {
        name: 'Full access',
        harness: 'codex',
        options: {
          model: 'configured-model',
          reasoningEffort: 'high',
          approvalPolicy: 'never',
          sandbox: 'danger-full-access',
        },
      },
      resumeId,
    )
    const request = (await configured.trace()).find(
      (record) => record.method === (resumeId ? 'thread/resume' : 'thread/start'),
    )
    expect(request.params).toEqual({
      cwd: configured.directory,
      model: 'configured-model',
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      config: { model_reasoning_effort: 'high' },
      ...(resumeId ? { threadId: resumeId, excludeTurns: true } : {}),
    })
    expect(await configured.argv()).toEqual(['app-server', '--listen', 'stdio://'])
    await configured.adapter.send('approval')
    await expect
      .poll(() => configured.events.some((e) => e.type === 'status' && e.status === 'idle'))
      .toBe(true)
    expect(configured.events.some((e) => e.type === 'interaction')).toBe(false)
  },
)

it.each([undefined, 'existing-thread'])(
  'leaves Codex defaults unset, including the previously observed model (%s)',
  async (resumeId) => {
    const configured = await setup({ name: 'Default', harness: 'codex', options: {} }, resumeId)
    const request = (await configured.trace()).find(
      (record) => record.method === (resumeId ? 'thread/resume' : 'thread/start'),
    )
    expect(request.params).toEqual({
      cwd: configured.directory,
      ...(resumeId ? { threadId: resumeId, excludeTurns: true } : {}),
    })
  },
)

it.each([undefined, 'claude-session'])(
  'maps Claude settings through the real SDK, including bypass and resume (%s)',
  async (resumeId) => {
    const configured = await setup(
      {
        name: 'Claude',
        harness: 'claude',
        options: {
          model: 'sonnet',
          effort: 'high',
          permissionMode: 'bypassPermissions',
          maxTurns: 7,
        },
      },
      resumeId,
    )
    await configured.adapter.send('hello')
    await expect
      .poll(() => configured.events.some((e) => e.type === 'status' && e.status === 'idle'), {
        timeout: 5000,
      })
      .toBe(true)
    expect(configured.events.filter((e) => e.type === 'error')).toEqual([])
    const args = await configured.argv()
    for (const [flag, value] of [
      ['--model', 'sonnet'],
      ['--permission-mode', 'bypassPermissions'],
      ['--max-turns', '7'],
      ['--effort', 'high'],
    ])
      expect(
        args.find((arg) => arg.startsWith(`${flag}=`))?.slice(flag.length + 1) ??
          args[args.indexOf(flag) + 1],
      ).toBe(value)
    expect(args).toContain('--allow-dangerously-skip-permissions')
    if (resumeId)
      expect(
        args.find((arg) => arg.startsWith('--resume='))?.slice(9) ??
          args[args.indexOf('--resume') + 1],
      ).toBe(resumeId)
  },
)

it.each([undefined, '/tmp/pi-session.jsonl'])(
  'builds Pi RPC arguments from provider, model, thinking, and native resume ID (%s)',
  async (resumeId) => {
    const configured = await setup(
      {
        name: 'Pi',
        harness: 'pi',
        options: { provider: 'openai', model: 'test-model', thinking: 'high' },
      },
      resumeId,
    )
    expect(await configured.argv()).toEqual([
      '--mode',
      'rpc',
      '--provider',
      'openai',
      '--model',
      'test-model',
      '--thinking',
      'high',
      ...(resumeId ? ['--session', resumeId] : []),
    ])
  },
)

it.each(['claude', 'pi'] as const)(
  'does not override %s defaults with an observed model',
  async (harness) => {
    const configured = await setup({ name: 'Default', harness, options: {} })
    await configured.adapter.send('hello')
    await expect
      .poll(() => configured.events.some((e) => e.type === 'status' && e.status === 'idle'), {
        timeout: 5000,
      })
      .toBe(true)
    const args = await configured.argv()
    expect(args).not.toContain('--model')
    expect(args).not.toContain('--permission-mode')
    expect(args).not.toContain('--thinking')
  },
)
