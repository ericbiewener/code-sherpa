import { randomUUID } from 'node:crypto'
import type {
  AgentAdapter,
  AgentEvent,
  Interaction,
  InteractionReply,
  Session,
  TranscriptItem,
} from '../../shared/types'

export interface AdapterOptions {
  session: Session
  executable: string
  env: NodeJS.ProcessEnv
  emit: (event: AgentEvent) => void
}

export abstract class BaseAdapter implements AgentAdapter {
  protected pending = new Map<string, (reply: InteractionReply) => void>()
  protected disposed = false
  constructor(protected options: AdapterOptions) {}
  protected emit(event: AgentEvent) {
    if (!this.disposed) this.options.emit(event)
  }
  protected message(
    role: TranscriptItem['role'],
    text: string,
    extra: Partial<TranscriptItem> = {},
  ) {
    const message = { role, text, createdAt: Date.now(), ...extra, id: extra.id ?? randomUUID() }
    this.emit({ type: 'message', message })
    return message.id
  }
  protected ask(interaction: Interaction, signal?: AbortSignal): Promise<InteractionReply> {
    if (signal?.aborted || this.disposed) return Promise.resolve({ approved: false })
    return new Promise((resolve) => {
      const finish = (reply: InteractionReply) => {
        this.pending.delete(interaction.id)
        signal?.removeEventListener('abort', cancel)
        this.emit({ type: 'interaction-resolved', id: interaction.id })
        resolve(reply)
      }
      const cancel = () => finish({ approved: false })
      this.pending.set(interaction.id, finish)
      signal?.addEventListener('abort', cancel, { once: true })
      this.emit({ type: 'interaction', interaction })
    })
  }
  async respond(id: string, reply: InteractionReply) {
    const callback = this.pending.get(id)
    if (!callback) throw new Error('This request is no longer pending')
    callback(reply)
  }
  protected cancelRequests() {
    for (const resolve of [...this.pending.values()]) resolve({ approved: false })
  }
  abstract start(): Promise<void>
  abstract send(text: string): Promise<void>
  abstract interrupt(): Promise<void>
  dispose() {
    this.cancelRequests()
    this.disposed = true
  }
}
