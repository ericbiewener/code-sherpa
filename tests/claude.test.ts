import { chmod } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeAll, expect, it } from 'vitest'
import { ClaudeAdapter } from '../src/main/agents/claude'
import type { AgentEvent, Session } from '../src/shared/types'

const fixture = fileURLToPath(new URL('./fixtures/agent.mjs', import.meta.url))
const adapters: ClaudeAdapter[] = []
beforeAll(() => chmod(fixture, 0o755))
afterEach(() => {
  for (const adapter of adapters.splice(0)) adapter.dispose()
})

function create() {
  const events: AgentEvent[] = []
  const session: Session = {
    id: 'local',
    harness: 'claude',
    cwd: process.cwd(),
    title: 'Test',
    status: 'idle',
    createdAt: 1,
    updatedAt: 1,
    messages: [],
    interactions: [],
  }
  const adapter = new ClaudeAdapter({
    session,
    executable: fixture,
    env: process.env,
    emit: (event) => events.push(event),
  })
  adapters.push(adapter)
  return { adapter, events }
}

it('uses the real SDK transport to stream replies and retain the native session ID', async () => {
  const { adapter, events } = create()
  await adapter.start()
  await adapter.send('hello')
  await expect
    .poll(() => events.some((e) => e.type === 'status' && e.status === 'idle'), { timeout: 5000 })
    .toBe(true)
  expect(events.filter((e) => e.type === 'error')).toEqual([])
  expect(events.some((e) => e.type === 'delta' && e.text.includes('Claude Code'))).toBe(true)
  expect(events.some((e) => e.type === 'session' && e.resumeId === 'claude-session')).toBe(true)
  await adapter.send('hello again')
  await expect
    .poll(() => events.filter((e) => e.type === 'status' && e.status === 'idle').length)
    .toBe(2)
})

it.each([true, false])('round trips SDK tool approvals (%s)', async (approved) => {
  const { adapter, events } = create()
  await adapter.start()
  await adapter.send('approval')
  await expect.poll(() => events.some((e) => e.type === 'interaction')).toBe(true)
  const request = events.find((e) => e.type === 'interaction')!
  if (request.type !== 'interaction') throw new Error('Missing request')
  await adapter.respond(request.interaction.id, { approved })
  await expect
    .poll(() =>
      events.some(
        (e) =>
          e.type === 'message' &&
          e.message.text === (approved ? 'Approved by you.' : 'Denied by you.'),
      ),
    )
    .toBe(true)
})

it('passes AskUserQuestion answers back as updated tool input', async () => {
  const { adapter, events } = create()
  await adapter.start()
  await adapter.send('question')
  await expect.poll(() => events.some((e) => e.type === 'interaction')).toBe(true)
  const request = events.find((e) => e.type === 'interaction')!
  if (request.type !== 'interaction') throw new Error('Missing request')
  expect(request.interaction.kind).toBe('question')
  await adapter.respond(request.interaction.id, {
    approved: true,
    answers: { 'Choose a color': 'Green' },
  })
  await expect
    .poll(() => events.some((e) => e.type === 'message' && e.message.text === 'You chose Green.'))
    .toBe(true)
})
