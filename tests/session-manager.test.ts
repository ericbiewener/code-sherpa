import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { AdapterOptions } from '../src/main/agents/base'
import { SessionManager } from '../src/main/session-manager'
import { SessionStore } from '../src/main/store'
import type { AgentAdapter, AgentEvent } from '../src/shared/types'

let directory: string
const managers: SessionManager[] = []
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'sherpa-test-'))
})
afterEach(async () => {
  await Promise.all(managers.splice(0).map((m) => m.dispose()))
  await rm(directory, { recursive: true, force: true })
})

function setup(onStart?: (options: AdapterOptions) => Promise<void>) {
  const instances: { options: AdapterOptions; disposed: boolean; prompts: string[] }[] = []
  const factory = (options: AdapterOptions): AgentAdapter => {
    const instance = { options, disposed: false, prompts: [] as string[] }
    instances.push(instance)
    return {
      async start() {
        await onStart?.(options)
        options.emit({ type: 'session', resumeId: options.session.resumeId ?? 'native-session' })
      },
      async send(text) {
        instance.prompts.push(text)
      },
      async interrupt() {},
      async respond(id) {
        options.emit({ type: 'interaction-resolved', id })
      },
      dispose() {
        instance.disposed = true
      },
    }
  }
  const store = new SessionStore(join(directory, 'sessions.json'))
  const manager = new SessionManager(
    store,
    {
      version: 2,
      defaultProfileId: 'codex',
      profiles: [
        { id: 'codex', name: 'Codex', harness: 'codex', executable: process.execPath, options: {} },
      ],
    },
    {},
    directory,
    () => {},
    factory,
  )
  managers.push(manager)
  return {
    manager,
    store,
    instances,
    emit: (event: AgentEvent) => instances.at(-1)?.options.emit(event),
  }
}

async function createReady(manager: SessionManager) {
  const id = await manager.create({ profileId: 'codex', cwd: directory })
  await expect.poll(() => manager.snapshot().sessions.find((s) => s.id === id)?.status).toBe('idle')
  return id
}

it('rejects overlapping turns, handles multiple approvals, and preserves tool input on completion', async () => {
  const { manager, emit } = setup()
  const id = await createReady(manager)
  await manager.send(id, 'Hello')
  await expect(manager.send(id, 'Duplicate')).rejects.toThrow('current turn')
  emit({ type: 'interaction', interaction: { id: 'a', kind: 'approval', title: 'First' } })
  emit({ type: 'interaction', interaction: { id: 'b', kind: 'approval', title: 'Second' } })
  await manager.respond(id, 'a', { approved: false })
  expect(manager.snapshot().sessions[0].status).toBe('waiting')
  await manager.respond(id, 'b', { approved: true })
  expect(manager.snapshot().sessions[0].status).toBe('running')
  emit({
    type: 'message',
    message: {
      id: 'tool',
      role: 'tool',
      title: 'Read',
      input: 'README.md',
      text: '',
      state: 'running',
      createdAt: 1,
    },
  })
  emit({
    type: 'message',
    message: { id: 'tool', role: 'tool', text: 'done', state: 'complete', createdAt: 2 },
  })
  expect(manager.snapshot().sessions[0].messages.at(-1)).toMatchObject({
    title: 'Read',
    input: 'README.md',
    text: 'done',
    createdAt: 1,
  })
})

it('disconnects interrupted runs so late events cannot corrupt the next turn', async () => {
  const { manager, instances } = setup()
  const id = await createReady(manager)
  await manager.send(id, 'first')
  await manager.interrupt(id)
  expect(instances[0].disposed).toBe(true)
  await manager.send(id, 'second')
  instances[0].options.emit({ type: 'status', status: 'idle' })
  expect(manager.snapshot().sessions[0].status).toBe('running')
  expect(instances[1].options.session.resumeId).toBe('native-session')
})

it('recovers from a crashed harness and reloads saved sessions without stale approvals', async () => {
  const { manager, emit, instances } = setup()
  const id = await createReady(manager)
  await manager.send(id, 'hello')
  emit({ type: 'error', message: 'process exited' })
  expect(manager.snapshot().sessions[0]).toMatchObject({ status: 'error', error: 'process exited' })
  await manager.send(id, 'try again')
  expect(instances).toHaveLength(2)
  emit({ type: 'interaction', interaction: { id: 'stale', kind: 'approval', title: 'A command' } })
  await manager.dispose()
  const reopened = setup().manager
  await reopened.load()
  expect(reopened.snapshot().sessions[0]).toMatchObject({
    id,
    status: 'idle',
    resumeId: 'native-session',
    interactions: [],
  })
  await reopened.send(id, 'continue')
  expect(reopened.snapshot().sessions[0].messages.at(-1)?.text).toBe('continue')
})

it('does not overwrite a corrupted store and rejects invalid project paths', async () => {
  const path = join(directory, 'sessions.json')
  await writeFile(path, '{broken')
  const { manager, store } = setup()
  await manager.load()
  expect(manager.snapshot().storageError).toContain('preserved')
  await expect(store.save([])).rejects.toThrow('disabled')
  expect(await readFile(path, 'utf8')).toBe('{broken')
  await expect(manager.create({ profileId: 'codex', cwd: 'relative' })).rejects.toThrow('absolute')
  await expect(manager.create({ profileId: 'codex', cwd: path })).rejects.toThrow('directory')
})

it('resumes a saved walkthrough with its original agent and native context without repeating the initial prompt', async () => {
  const { manager, instances, emit } = setup()
  const prUrl = 'https://github.com/example/project/pull/42'
  const initialPrompt = 'Summarize this PR.'
  const id = await manager.create({ profileId: 'codex', cwd: directory, prUrl, initialPrompt })
  await expect.poll(() => instances[0].prompts).toEqual([initialPrompt])
  emit({ type: 'status', status: 'idle' })
  await manager.close(id)
  expect(instances[0].disposed).toBe(true)
  await manager.send(id, 'Explain the tests.')
  expect(instances[1].prompts).toEqual(['Explain the tests.'])
  expect(instances[1].options.session.resumeId).toBe('native-session')
  emit({ type: 'status', status: 'idle' })
  await manager.dispose()

  const reopened = setup()
  await reopened.manager.load()
  reopened.manager.setConfig({ version: 2, profiles: [] })
  expect(reopened.manager.snapshot().sessions).toMatchObject([
    { id, prUrl, title: prUrl, resumeId: 'native-session', status: 'idle' },
  ])
  await reopened.manager.send(id, 'Continue after restarting.')
  expect(reopened.instances[0].options.session.resumeId).toBe('native-session')
  expect(reopened.instances[0].options.session.settings?.executable).toBe(process.execPath)
  expect(reopened.instances[0].prompts).toEqual(['Continue after restarting.'])
  expect(reopened.manager.snapshot().sessions[0].messages.map((message) => message.text)).toEqual([
    initialPrompt,
    'Explain the tests.',
    'Continue after restarting.',
  ])
})

it('keeps existing sessions on their original integration settings when profiles change', async () => {
  const { manager, instances } = setup()
  const original = await createReady(manager)
  manager.setConfig({
    version: 2,
    defaultProfileId: 'codex',
    profiles: [
      {
        id: 'codex',
        name: 'Changed profile',
        harness: 'pi',
        executable: process.execPath,
        options: { model: 'new-model', thinking: 'high' },
      },
    ],
  })
  await manager.interrupt(original)
  await manager.send(original, 'continue with original command')
  expect(instances[1].options.session.harness).toBe('codex')
  expect(instances[1].options.session.settings?.options).toEqual({})
  const next = await createReady(manager)
  const session = manager.snapshot().sessions.find((s) => s.id === next)!
  expect(session.harness).toBe('pi')
  expect(session.profileName).toBe('Changed profile')
  expect(instances[2].options.session.settings?.options).toEqual({
    model: 'new-model',
    thinking: 'high',
  })
})

it('exposes and answers startup dialogs before initialization completes', async () => {
  let finish!: () => void
  const { manager } = setup(async (options) => {
    options.emit({
      type: 'interaction',
      interaction: { id: 'startup', kind: 'approval', title: 'Trust project?' },
    })
    await new Promise<void>((resolve) => {
      finish = resolve
    })
  })
  const id = await manager.create({ profileId: 'codex', cwd: directory })
  await expect.poll(() => manager.snapshot().sessions[0].status).toBe('waiting')
  await manager.respond(id, 'startup', { approved: true })
  finish()
  await expect.poll(() => manager.snapshot().sessions[0].status).toBe('idle')
  await manager.send(id, 'now work')
})

it('does not start a prompt after the user cancels a slow reconnection', async () => {
  let finish!: () => void
  let starts = 0
  const { manager, instances } = setup(async () => {
    if (++starts > 1)
      await new Promise<void>((resolve) => {
        finish = resolve
      })
  })
  const id = await createReady(manager)
  await manager.interrupt(id)
  const sending = manager.send(id, 'cancel me')
  await expect.poll(() => typeof finish).toBe('function')
  await manager.interrupt(id)
  finish()
  await sending
  expect(instances[1].prompts).toEqual([])
  expect(manager.snapshot().sessions[0].status).toBe('idle')
})

it('sends an initial prompt exactly once after startup dialogs are answered', async () => {
  let finish!: () => void
  const { manager, instances } = setup(async (options) => {
    options.emit({
      type: 'interaction',
      interaction: { id: 'startup', kind: 'approval', title: 'Trust project?' },
    })
    await new Promise<void>((resolve) => {
      finish = resolve
    })
  })
  const initialPrompt = 'Fetch this PR and summarize it.'
  const id = await manager.create({ profileId: 'codex', cwd: directory, initialPrompt })
  await expect.poll(() => manager.snapshot().sessions[0].status).toBe('waiting')
  expect(instances[0].prompts).toEqual([])
  expect(manager.snapshot().sessions[0].messages).toMatchObject([
    { role: 'user', text: initialPrompt },
  ])
  await manager.respond(id, 'startup', { approved: true })
  finish()
  await expect.poll(() => instances[0].prompts).toEqual([initialPrompt])
  expect(manager.snapshot().sessions[0].status).toBe('running')
})

it('does not send an initial prompt after closing a session during startup', async () => {
  let finish!: () => void
  const { manager, instances } = setup(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      }),
  )
  const id = await manager.create({
    profileId: 'codex',
    cwd: directory,
    initialPrompt: 'Cancel this walkthrough.',
  })
  await expect.poll(() => typeof finish).toBe('function')
  await manager.close(id)
  finish()
  // Drain startup and the pending send before checking for a late prompt.
  await new Promise((resolve) => setImmediate(resolve))
  expect(instances[0].prompts).toEqual([])
  expect(instances[0].disposed).toBe(true)
  expect(manager.snapshot().sessions[0].status).toBe('idle')
})

it('preserves an initial prompt and exposes startup failures for recovery', async () => {
  const { manager, instances } = setup(async () => {
    throw new Error('Agent could not start')
  })
  await manager.create({ profileId: 'codex', cwd: directory, initialPrompt: 'Summarize this PR.' })
  await expect.poll(() => manager.snapshot().sessions[0].status).toBe('error')
  expect(manager.snapshot().sessions[0]).toMatchObject({
    error: 'Agent could not start',
    messages: [{ role: 'user', text: 'Summarize this PR.' }],
  })
  expect(instances[0].prompts).toEqual([])
  expect(instances[0].disposed).toBe(true)
})

it('lets legacy sessions with unsupported flags choose reviewed settings without losing native context', async () => {
  const first = setup()
  const id = await createReady(first.manager)
  await first.manager.dispose()
  const sessions = await first.store.load()
  delete sessions[0].settings
  sessions[0].launchCommand = `${JSON.stringify(process.execPath)} --profile old`
  await first.store.save(sessions)
  const reopened = setup()
  await reopened.manager.load()
  expect(reopened.manager.snapshot().sessions[0].settingsMigration?.command).toContain(
    '--profile old',
  )
  expect(() => reopened.manager.configureSession(id, 'missing')).toThrow('same integration')
  reopened.manager.configureSession(id, 'codex')
  expect(reopened.manager.snapshot().sessions[0].settingsMigration).toBeUndefined()
  await reopened.manager.send(id, 'continue')
  expect(reopened.instances[0].options.session.resumeId).toBe('native-session')
  expect(reopened.instances[0].options.session.settings?.executable).toBe(process.execPath)
  expect(() => reopened.manager.configureSession(id, 'codex')).toThrow('Only legacy')
})
