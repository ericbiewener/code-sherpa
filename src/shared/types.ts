export const harnesses = ['codex', 'claude', 'pi'] as const
export type Harness = (typeof harnesses)[number]
export const agentNames = { codex: 'Codex', claude: 'Claude Code', pi: 'Pi' }
export const agentConfigDirectories = {
  codex: { variable: 'CODEX_HOME', defaultPath: '~/.codex' },
  claude: { variable: 'CLAUDE_CONFIG_DIR', defaultPath: '~/.claude' },
  pi: { variable: 'PI_CODING_AGENT_DIR', defaultPath: '~/.pi/agent' },
} as const
export const codexEfforts = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const
export const claudeEfforts = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export const piThinkingLevels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

export interface CodexSettings {
  model?: string
  reasoningEffort?: (typeof codexEfforts)[number]
  approvalPolicy?: 'untrusted' | 'on-request' | 'never'
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access'
}
export interface ClaudeSettings {
  model?: string
  effort?: (typeof claudeEfforts)[number]
  permissionMode?: 'default' | 'acceptEdits' | 'plan' | 'dontAsk' | 'auto' | 'bypassPermissions'
  maxTurns?: number
}
export interface PiSettings {
  provider?: string
  model?: string
  thinking?: (typeof piThinkingLevels)[number]
}
export type AgentSettings = { name: string; executable?: string; configDir?: string } & (
  | { harness: 'codex'; options: CodexSettings }
  | { harness: 'claude'; options: ClaudeSettings }
  | { harness: 'pi'; options: PiSettings }
)
export interface SettingsMigration {
  command: string
  issues: string[]
  needsIntegration?: boolean
}
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
  settings?: AgentSettings
  settingsMigration?: SettingsMigration
  profileName?: string
  title: string
  prUrl?: string
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
  initialPrompt?: string
  prUrl?: string
  cwd: string
  resumeId?: string
}

export type AgentProfile = AgentSettings & { id: string; migration?: SettingsMigration }

export interface AppConfig {
  version: 2
  defaultProfileId?: string
  profiles: AgentProfile[]
}

export type ProfileInfo = AgentProfile & {
  resolvedExecutable?: string
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
  addProfile(settings: AgentSettings): Promise<void>
  cloneProfile(id: string): Promise<string>
  updateProfile(id: string, settings: AgentSettings): Promise<void>
  deleteProfile(id: string): Promise<void>
  reloadConfig(): Promise<void>
  createSession(input: NewSession): Promise<string>
  closeSession(id: string): Promise<void>
  configureSession(id: string, profileId: string): Promise<void>
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
