import { randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type {
  AgentAdapter,
  AgentEvent,
  AppState,
  AppConfig,
  ProfileInfo,
  InteractionReply,
  NewSession,
  Session,
} from '../shared/types'
import { createAdapter } from './agents'
import type { AdapterOptions } from './agents/base'
import { errorMessage } from './agents/transport'
import { SessionStore } from './store'
import { inferHarness, inspectProfiles, resolveCommand } from './commands'

interface Connection {
  adapter: AgentAdapter
  ready: Promise<void>
}

export class SessionManager {
  private sessions = new Map<string, Session>()
  private connections = new Map<string, Connection>()
  private stopping = new Set<string>()
  private broadcastTimer?: NodeJS.Timeout
  private saveTimer?: NodeJS.Timeout
  private storageError?: string
  private closing = false
  private profiles: ProfileInfo[]
  private configError?: string

  constructor(
    private store: SessionStore,
    private config: AppConfig,
    private env: NodeJS.ProcessEnv,
    private defaultCwd: string,
    private broadcast: (state: AppState) => void,
    private adapterFactory: (options: AdapterOptions) => AgentAdapter = createAdapter,
    private configPath = '',
  ) {
    this.profiles = inspectProfiles(config.profiles, env)
  }

  async load() {
    try {
      for (const session of await this.store.load()) this.sessions.set(session.id, session)
    } catch (error) {
      this.storageError = errorMessage(error)
    }
  }

  snapshot(): AppState {
    return {
      config: this.config,
      profiles: this.profiles,
      configPath: this.configPath,
      configError: this.configError,
      sessions: [...this.sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt),
      defaultCwd: this.defaultCwd,
      storageError: this.storageError,
    }
  }

  setConfig(config: AppConfig) {
    this.config = config
    this.profiles = inspectProfiles(config.profiles, this.env)
    this.configError = undefined
    this.changed()
  }

  setConfigError(error: string) {
    this.configError = error
    this.changed()
  }

  refreshProfiles() {
    this.profiles = inspectProfiles(this.config.profiles, this.env)
    this.changed()
  }

  async create(input: NewSession): Promise<string> {
    if (!isAbsolute(input.cwd)) throw new Error('Choose an absolute project folder path')
    const cwd = await realpath(input.cwd)
    if (!(await stat(cwd)).isDirectory()) throw new Error('The project path must be a directory')
    const profile = this.config.profiles.find((p) => p.id === input.profileId)
    if (!profile) throw new Error('Choose an existing launch profile')
    const harness = profile.harness ?? input.harness ?? inferHarness(profile.command, this.env)
    if (!harness) throw new Error('Choose which agent this command runs')
    resolveCommand(profile.command, this.env)
    if (
      input.resumeId &&
      [...this.sessions.values()].some(
        (s) => s.harness === harness && s.resumeId === input.resumeId,
      )
    ) {
      throw new Error('This conversation is already in the sidebar')
    }
    const session: Session = {
      model: input.model,
      resumeId: input.resumeId,
      harness,
      launchCommand: profile.command,
      profileName: profile.name,
      cwd,
      id: randomUUID(),
      title: input.resumeId ? 'Resumed conversation' : 'New conversation',
      status: 'starting',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
      interactions: [],
    }
    this.sessions.set(session.id, session)
    this.changed()
    try {
      const connection = this.connect(session)
      // Return the local ID immediately so startup dialogs are answerable while
      // the native harness is still initializing.
      void connection.ready
        .then(() => {
          if (this.connections.get(session.id) !== connection) return
          session.status = session.interactions.length ? 'waiting' : 'idle'
          this.changed()
        })
        .catch((error) => {
          if (this.connections.get(session.id) === connection) this.fail(session, error)
        })
    } catch (error) {
      this.fail(session, error)
    }
    return session.id
  }

  private connect(session: Session): Connection {
    const existing = this.connections.get(session.id)
    if (existing) return existing
    const { executable, args } = resolveCommand(session.launchCommand ?? session.harness, this.env)
    const adapter = this.adapterFactory({
      session,
      executable,
      args,
      env: this.env,
      emit: (event) => {
        if (this.connections.get(session.id)?.adapter === adapter && !this.stopping.has(session.id))
          this.apply(session, event)
      },
    })
    const connection = { adapter, ready: Promise.resolve() }
    this.connections.set(session.id, connection)
    connection.ready = Promise.resolve().then(() => adapter.start())
    return connection
  }

  async send(id: string, text: string) {
    const session = this.get(id)
    if (this.stopping.has(id) || ['running', 'waiting', 'starting'].includes(session.status))
      throw new Error('Wait for the current turn or stop it first')
    session.error = undefined
    session.status = 'starting'
    session.updatedAt = Date.now()
    session.messages.push({ id: randomUUID(), role: 'user', text, createdAt: Date.now() })
    if (session.title === 'New conversation') session.title = text.replace(/\s+/g, ' ').slice(0, 70)
    this.changed()
    let connection: Connection | undefined
    try {
      connection = this.connect(session)
      await connection.ready
      // An interrupted startup or removed session must never launch a prompt.
      if (this.connections.get(id) !== connection || this.closing) return
      session.status = 'running'
      this.changed()
      await connection.adapter.send(text)
    } catch (error) {
      if (
        (!connection || this.connections.get(id) === connection) &&
        this.sessions.has(id) &&
        !this.closing
      )
        this.fail(session, error)
    }
  }

  private apply(session: Session, event: AgentEvent) {
    switch (event.type) {
      case 'message': {
        const index = session.messages.findIndex((m) => m.id === event.message.id)
        const message =
          event.message.role === 'tool'
            ? { ...event.message, text: limitOutput(event.message.text) }
            : event.message
        if (index === -1) session.messages.push(message)
        else
          session.messages[index] = {
            ...session.messages[index],
            ...message,
            createdAt: session.messages[index].createdAt,
          }
        break
      }
      case 'delta': {
        let message = session.messages.find((m) => m.id === event.id)
        if (!message) {
          message = {
            id: event.id,
            role: 'assistant',
            text: '',
            createdAt: Date.now(),
            state: 'running',
          }
          session.messages.push(message)
        }
        message.text += event.text
        if (message.role === 'tool') message.text = limitOutput(message.text)
        break
      }
      case 'session':
        if (event.resumeId) session.resumeId = event.resumeId
        if (event.model) session.model = event.model
        break
      case 'status':
        session.status =
          session.interactions.length && event.status === 'running' ? 'waiting' : event.status
        if (event.status === 'idle') {
          for (const message of session.messages)
            if (message.state === 'running') message.state = 'complete'
        }
        break
      case 'interaction':
        if (!session.interactions.some((i) => i.id === event.interaction.id))
          session.interactions.push(event.interaction)
        session.status = 'waiting'
        break
      case 'interaction-resolved':
        session.interactions = session.interactions.filter((i) => i.id !== event.id)
        if (!session.interactions.length && session.status === 'waiting') session.status = 'running'
        break
      case 'error':
        this.fail(session, new Error(event.message))
        return
    }
    session.updatedAt = Date.now()
    this.changed()
  }

  private fail(session: Session, error: unknown) {
    this.disconnect(session.id)
    session.status = 'error'
    session.error = errorMessage(error)
    session.interactions = []
    for (const message of session.messages) if (message.state === 'running') message.state = 'error'
    this.changed()
  }

  async interrupt(id: string) {
    const session = this.get(id)
    const connection = this.connections.get(id)
    if (!connection || this.stopping.has(id)) return
    this.stopping.add(id)
    let timer: NodeJS.Timeout | undefined
    try {
      if (session.status !== 'starting') {
        // Hard-close if a harness cannot acknowledge cancellation promptly.
        await Promise.race([
          connection.adapter.interrupt(),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, 5000)
          }),
        ])
      }
    } catch {
      // Closing the process below also stops agents whose interrupt RPC failed.
    } finally {
      clearTimeout(timer)
      // Reconnect using the saved ID on the next turn. This prevents late
      // completion events from an interrupted turn corrupting a newer turn.
      this.disconnect(id)
      this.stopping.delete(id)
    }
    session.interactions = []
    session.status = 'idle'
    session.error = undefined
    for (const message of session.messages) if (message.state === 'running') message.state = 'error'
    session.messages.push({
      id: randomUUID(),
      role: 'notice',
      text: 'Turn stopped.',
      createdAt: Date.now(),
    })
    this.changed()
  }

  async respond(id: string, interactionId: string, reply: InteractionReply) {
    const session = this.get(id)
    const connection = this.connections.get(id)
    if (!connection || !session.interactions.some((i) => i.id === interactionId))
      throw new Error('This request has already ended')
    await connection.adapter.respond(interactionId, reply)
  }

  rename(id: string, title: string) {
    this.get(id).title = title
    this.changed()
  }

  async close(id: string) {
    const session = this.get(id)
    if (['starting', 'running', 'waiting'].includes(session.status)) await this.interrupt(id)
    this.disconnect(id)
  }

  remove(id: string) {
    this.get(id)
    this.disconnect(id)
    this.sessions.delete(id)
    this.changed()
  }

  private disconnect(id: string) {
    const connection = this.connections.get(id)
    this.connections.delete(id)
    connection?.adapter.dispose()
  }

  private get(id: string) {
    const session = this.sessions.get(id)
    if (!session) throw new Error('Session not found')
    return session
  }

  private changed() {
    if (this.closing) return
    if (!this.broadcastTimer)
      this.broadcastTimer = setTimeout(() => {
        this.broadcastTimer = undefined
        this.broadcast(this.snapshot())
      }, 40)
    if (!this.saveTimer)
      this.saveTimer = setTimeout(() => {
        this.saveTimer = undefined
        void this.persist()
      }, 300)
  }

  private async persist() {
    try {
      await this.store.save([...this.sessions.values()])
    } catch (error) {
      this.storageError = errorMessage(error)
      this.broadcast(this.snapshot())
    }
  }

  async dispose() {
    this.closing = true
    clearTimeout(this.broadcastTimer)
    clearTimeout(this.saveTimer)
    for (const id of this.connections.keys()) this.disconnect(id)
    await this.persist()
  }
}

function limitOutput(text: string) {
  return text.length > 100_000 ? '[Earlier output omitted]\n' + text.slice(-100_000) : text
}
