export const harnesses = ['codex', 'claude', 'pi'] as const
export type Harness = (typeof harnesses)[number]
export type SessionStatus = 'idle' | 'starting' | 'running' | 'waiting' | 'error'

export interface TranscriptItem {
  id: string
  role: 'user' | 'assistant' | 'tool' | 'notice'
  text: string
  title?: string
  input?: string
  state?: 'running' | 'complete' | 'error'
  createdAt: number
}

export interface Question {
  id: string
  label: string
  options?: string[]
  multiple?: boolean
  secret?: boolean
  multiline?: boolean
  defaultValue?: string
}

export interface Interaction {
  id: string
  kind: 'approval' | 'question'
  title: string
  detail?: string
  approveLabel?: string
  questions?: Question[]
}

export interface InteractionReply {
  approved: boolean
  answers?: Record<string, string>
}

export interface Session {
  id: string
  harness: Harness
  launchCommand?: string
  profileName?: string
  title: string
  cwd: string
  model?: string
  resumeId?: string
  status: SessionStatus
  createdAt: number
  updatedAt: number
  messages: TranscriptItem[]
  interactions: Interaction[]
  error?: string
}

export interface HarnessInfo {
  id: Harness
  name: string
  executable?: string
  version?: string
  error?: string
}

export interface NewSession {
  profileId: string
  harness?: Harness
  cwd: string
  model?: string
  resumeId?: string
}

export interface AgentProfile {
  id: string
  name: string
  harness?: Harness
  command: string
}

export interface CommandSettings {
  name: string
  command: string
}

export interface AppConfig {
  version: 1
  defaultProfileId?: string
  profiles: AgentProfile[]
}

export interface ProfileInfo extends AgentProfile {
  executable?: string
  error?: string
}

export interface AppState {
  config: AppConfig
  profiles: ProfileInfo[]
  configPath: string
  configError?: string
  sessions: Session[]
  defaultCwd: string
  storageError?: string
}

export interface SherpaAPI {
  getState(): Promise<AppState>
  addCommand(settings: CommandSettings): Promise<void>
  updateCommand(id: string, settings: CommandSettings): Promise<void>
  deleteCommand(id: string): Promise<void>
  reloadConfig(): Promise<void>
  createSession(input: NewSession): Promise<string>
  closeSession(id: string): Promise<void>
  sendMessage(id: string, text: string): Promise<void>
  interrupt(id: string): Promise<void>
  respond(id: string, interactionId: string, reply: InteractionReply): Promise<void>
  openExternal(url: string): Promise<void>
  onState(callback: (state: AppState) => void): () => void
}

export type AgentEvent =
  | { type: 'message'; message: TranscriptItem }
  | { type: 'delta'; id: string; text: string }
  | { type: 'session'; resumeId?: string; model?: string }
  | { type: 'interaction'; interaction: Interaction }
  | { type: 'interaction-resolved'; id: string }
  | { type: 'status'; status: SessionStatus }
  | { type: 'error'; message: string }

export interface AgentAdapter {
  start(): Promise<void>
  send(text: string): Promise<void>
  interrupt(): Promise<void>
  respond(id: string, reply: InteractionReply): Promise<void>
  dispose(): void
}
