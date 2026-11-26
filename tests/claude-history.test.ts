import { getSessionInfo, getSessionMessages } from '@anthropic-ai/claude-agent-sdk'
import { expect, it, vi } from 'vitest'
import { ClaudeAdapter } from '../src/main/agents/claude'
import type { AgentEvent } from '../src/shared/types'

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  getSessionInfo: vi.fn(),
  getSessionMessages: vi.fn(),
  query: vi.fn(),
}))

it('does not read the host account history when resuming Claude with a different configuration directory', async () => {
  const events: AgentEvent[] = []
  const adapter = new ClaudeAdapter({
    session: {
      id: 'local',
      title: 'Resumed',
      harness: 'claude',
      cwd: process.cwd(),
      resumeId: 'native-id',
      settings: { name: 'Work', harness: 'claude', options: {}, configDir: '/work/claude' },
      status: 'idle',
      createdAt: 0,
      updatedAt: 0,
      messages: [],
      interactions: [],
    },
    executable: 'unused',
    env: { ...process.env, CLAUDE_CONFIG_DIR: '/work/claude' },
    emit: (event) => events.push(event),
  })
  await adapter.start()
  expect(getSessionInfo).not.toHaveBeenCalled()
  expect(getSessionMessages).not.toHaveBeenCalled()
  expect(events).toContainEqual(
    expect.objectContaining({
      type: 'message',
      message: expect.objectContaining({
        role: 'notice',
        text: expect.stringContaining('native context will resume'),
      }),
    }),
  )
  adapter.dispose()
})
