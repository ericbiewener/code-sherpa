import { Code2, Sparkles, Terminal } from 'lucide-react'
import type { Harness, SessionStatus } from '../../shared/types'

export const agentNames = { codex: 'Codex', claude: 'Claude Code', pi: 'Pi' }
export function customCommandName(name: string | undefined, command: string) {
  return name && name !== command.slice(0, 80) ? name : ''
}
export const statusLabels: Record<SessionStatus, string> = {
  idle: 'Ready',
  starting: 'Connecting',
  running: 'Working',
  waiting: 'Needs input',
  error: 'Interrupted',
}

export function AgentIcon({ harness, size = 18 }: { harness: Harness; size?: number }) {
  const Icon = { codex: Code2, claude: Sparkles, pi: Terminal }[harness]
  return <Icon size={size} strokeWidth={1.7} />
}

export function cleanError(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).replace(
    /^Error invoking remote method '[^']+': (Error: )?/,
    '',
  )
}
