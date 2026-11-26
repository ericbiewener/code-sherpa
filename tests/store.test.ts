import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { SessionStore } from '../src/main/store'
import type { Session } from '../src/shared/types'
import { newSessionSchema } from '../src/shared/validation'

let directory: string
let store: SessionStore
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'sherpa-store-'))
  store = new SessionStore(join(directory, 'sessions.json'))
})
afterEach(() => rm(directory, { recursive: true, force: true }))

function legacySession(prompt: string): Session {
  return {
    id: 'saved',
    harness: 'codex',
    title: prompt.slice(0, 70),
    cwd: directory,
    resumeId: 'existing-thread',
    status: 'idle',
    createdAt: 1,
    updatedAt: 2,
    messages: [{ id: 'prompt', role: 'user', text: prompt, createdAt: 1 }],
    interactions: [],
  }
}

it.each(['', '# Global guidelines\n\nUse gh for GitHub.\n\n# User prompt\n\n'])(
  'recovers walkthroughs created before PR metadata was saved (prefix: %j)',
  async (prefix) => {
    const prUrl = 'https://git.example.com/team/project/pull/42'
    const session = legacySession(
      `${prefix}Fetch the full PR diff, title, and body for this URL: ${prUrl}. Summarize the changeset.`,
    )
    await store.save([session])
    expect(await store.load()).toEqual([{ ...session, prUrl, title: prUrl }])
  },
)

it('keeps basic sessions out of walkthrough history and ignores invalid legacy URLs', async () => {
  const prompts = [
    'Explain https://github.com/example/project/pull/42',
    'Fetch the full PR diff, title, and body for this URL: file:///tmp/pr. Summarize the changeset.',
    'Fetch the full PR diff, title, and body for this URL: https://. Summarize the changeset.',
  ]
  const sessions = prompts.map((prompt, index) => ({ ...legacySession(prompt), id: String(index) }))
  await store.save(sessions)
  expect(await store.load()).toEqual(sessions)
})

it.each(['file:///tmp/pr', 'https://', 'not a URL'])(
  'rejects invalid PR metadata at the IPC boundary (%s)',
  (prUrl) => {
    expect(newSessionSchema.safeParse({ profileId: 'codex', cwd: directory, prUrl }).success).toBe(
      false,
    )
  },
)
