import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ClaudeAdapter } from '../src/main/agents/claude'
import { CodexAdapter } from '../src/main/agents/codex'
import { PiAdapter } from '../src/main/agents/pi'
import type { AgentAdapter, AgentEvent, Session } from '../src/shared/types'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const clean of cleanup.splice(0)) await clean()
})

it.each(['codex', 'claude', 'pi'] as const)(
  'forwards custom startup arguments through the %s adapter',
  async (harness) => {
    const directory = await mkdtemp(join(tmpdir(), 'sherpa-launch-'))
    const argvFile = join(directory, 'argv.json')
    const fixture = resolve('tests/fixtures/agent.mjs')
    await chmod(fixture, 0o755)
    const session: Session = {
      id: 'test',
      title: 'Test',
      harness,
      cwd: directory,
      status: 'idle',
      createdAt: 0,
      updatedAt: 0,
      messages: [],
      interactions: [],
    }
    const events: AgentEvent[] = []
    const Adapter = { codex: CodexAdapter, claude: ClaudeAdapter, pi: PiAdapter }[harness]
    const adapter: AgentAdapter = new Adapter({
      session,
      executable: fixture,
      args: ['--custom-profile', 'two words'],
      env: { ...process.env, SHERPA_FIXTURE_ARGV: argvFile },
      emit: (event) => events.push(event),
    })
    cleanup.push(async () => {
      adapter.dispose()
      await rm(directory, { recursive: true, force: true })
    })
    await adapter.start()
    await adapter.send('hello')
    await expect
      .poll(() => events.some((e) => e.type === 'status' && e.status === 'idle'))
      .toBe(true)
    const args = JSON.parse(await readFile(argvFile, 'utf8'))
    expect(args.slice(0, 2)).toEqual(['--custom-profile', 'two words'])
    expect(args).toContain(
      harness === 'codex' ? 'app-server' : harness === 'claude' ? '--input-format' : '--mode',
    )
  },
)
