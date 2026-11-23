import { beforeAll, afterEach, describe, expect, it } from 'vitest'
import { chmod } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { CodexAdapter } from '../src/main/agents/codex'
import { PiAdapter } from '../src/main/agents/pi'
import type { AgentAdapter, AgentEvent, Harness, Session } from '../src/shared/types'

const fixture = fileURLToPath(new URL('./fixtures/agent.mjs', import.meta.url))
const adapters: AgentAdapter[] = []
beforeAll(() => chmod(fixture, 0o755))
afterEach(() => {
  adapters.splice(0).forEach((adapter) => adapter.dispose())
})

function create(harness: Harness, resumeId?: string) {
  const events: AgentEvent[] = []
  const session: Session = {
    id: 'local',
    harness,
    cwd: process.cwd(),
    title: 'Test',
    status: 'idle',
    createdAt: 1,
    updatedAt: 1,
    messages: [],
    interactions: [],
    resumeId,
  }
  const Adapter = harness === 'codex' ? CodexAdapter : PiAdapter
  const adapter = new Adapter({
    session,
    executable: fixture,
    env: process.env,
    emit: (event) => events.push(event),
  })
  adapters.push(adapter)
  return { adapter, events }
}

describe.each(['codex', 'pi'] as const)('%s adapter', (harness) => {
  it('streams messages and tool output, then finishes the turn', async () => {
    const { adapter, events } = create(harness)
    await adapter.start()
    await adapter.send('hello')
    await expect
      .poll(() => events.some((event) => event.type === 'status' && event.status === 'idle'))
      .toBe(true)
    expect(events.some((event) => event.type === 'delta' && event.text.length > 0)).toBe(true)
    expect(events.some((event) => event.type === 'message' && event.message.role === 'tool')).toBe(
      true,
    )
    expect(events.some((event) => event.type === 'session' && !!event.resumeId)).toBe(true)
  })

  it.each([true, false])('waits for an explicit approval decision (%s)', async (approved) => {
    const { adapter, events } = create(harness)
    await adapter.start()
    await adapter.send('approval')
    await expect.poll(() => events.some((e) => e.type === 'interaction')).toBe(true)
    expect(events.some((e) => e.type === 'status' && e.status === 'idle')).toBe(false)
    await adapter.respond('approve-1', { approved })
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

  it('answers a question in the harness-specific format', async () => {
    const { adapter, events } = create(harness)
    await adapter.start()
    await adapter.send('question')
    await expect.poll(() => events.some((e) => e.type === 'interaction')).toBe(true)
    await adapter.respond('question-1', {
      approved: true,
      answers: { color: 'Green', value: 'Green' },
    })
    await expect
      .poll(() => events.some((e) => e.type === 'message' && e.message.text === 'You chose Green.'))
      .toBe(true)
  })

  it('loads existing conversation history when resuming', async () => {
    const { adapter, events } = create(harness, 'existing-session')
    await adapter.start()
    expect(
      events.some(
        (e) =>
          e.type === 'message' && e.message.role === 'user' && /previous/i.test(e.message.text),
      ),
    ).toBe(true)
    if (harness === 'codex')
      expect(
        events.some((e) => e.type === 'message' && e.message.text === 'A previous answer.'),
      ).toBe(true)
  })

  it('can interrupt an active turn and reports process crashes', async () => {
    const { adapter, events } = create(harness)
    await adapter.start()
    await adapter.send('wait')
    await adapter.interrupt()
    await expect
      .poll(() => events.some((e) => e.type === 'status' && e.status === 'idle'))
      .toBe(true)
    await expect(adapter.send('crash')).rejects.toThrow('Fixture startup failure')
    expect(events.some((e) => e.type === 'error')).toBe(true)
  })
})
