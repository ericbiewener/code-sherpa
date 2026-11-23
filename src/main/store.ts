import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import { harnesses, type Session } from '../shared/types'

const itemSchema = z.object({
  id: z.string(),
  role: z.enum(['user', 'assistant', 'tool', 'notice']),
  text: z.string(),
  title: z.string().optional(),
  input: z.string().optional(),
  state: z.enum(['running', 'complete', 'error']).optional(),
  createdAt: z.number(),
})
const sessionSchema = z.object({
  id: z.string(),
  harness: z.enum(harnesses),
  launchCommand: z.string().optional(),
  profileName: z.string().optional(),
  title: z.string(),
  cwd: z.string(),
  model: z.string().optional(),
  resumeId: z.string().optional(),
  status: z.enum(['idle', 'starting', 'running', 'waiting', 'error']),
  createdAt: z.number(),
  updatedAt: z.number(),
  messages: z.array(itemSchema),
  error: z.string().optional(),
})
const storeSchema = z.object({ version: z.literal(1), sessions: z.array(sessionSchema) })

export class SessionStore {
  private writes = Promise.resolve()
  private writable = true
  constructor(readonly path: string) {}

  async load(): Promise<Session[]> {
    try {
      const data = storeSchema.parse(JSON.parse(await readFile(this.path, 'utf8')))
      return data.sessions.map((session) => ({
        ...session,
        status: 'idle',
        error: undefined,
        interactions: [],
        messages: session.messages.map((item) =>
          item.state === 'running' ? { ...item, state: 'error' } : item,
        ),
      }))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      this.writable = false
      throw new Error(
        `Could not read saved sessions at ${this.path}. The original file has been preserved. ${String(error)}`,
      )
    }
  }

  save(sessions: Session[]): Promise<void> {
    if (!this.writable)
      return Promise.reject(
        new Error(
          `Session saving is disabled until ${this.path} is repaired or moved aside and the app is restarted.`,
        ),
      )
    // Never persist unanswered prompts, which cannot be answered after restart.
    const data = JSON.stringify({
      version: 1,
      sessions: sessions.map(({ interactions: _, ...session }) => session),
    })
    const write = this.writes
      .catch(() => {})
      .then(async () => {
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
        await writeFile(this.path + '.tmp', data, { mode: 0o600 })
        await rename(this.path + '.tmp', this.path)
      })
    this.writes = write
    return write
  }
}
