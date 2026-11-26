import type { Harness, SessionStatus } from '../../shared/types'
import claudeLogo from './assets/agents/claude.svg'
import codexLogo from './assets/agents/codex.png'
import piLogo from './assets/agents/pi.svg'

export { agentNames } from '../../shared/types'
export const statusLabels: Record<SessionStatus, string> = {
  idle: 'Ready',
  starting: 'Connecting',
  running: 'Working',
  waiting: 'Needs input',
  error: 'Interrupted',
}

const agentLogos: Record<Harness, string> = {
  // OpenAI desktop app: Resources/icon-codex-light.png.
  codex: codexLogo,
  // Official Claude Code VS Code extension 2.1.332: resources/claude-logo.svg.
  claude: claudeLogo,
  // https://pi.dev/press-kit — compact mark from https://pi.dev/favicon.svg.
  pi: piLogo,
}

export function AgentIcon({ harness, size = 18 }: { harness: Harness; size?: number }) {
  return (
    <img
      className="agent-icon"
      src={agentLogos[harness]}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  )
}

export function cleanError(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).replace(
    /^Error invoking remote method '[^']+': (Error: )?/,
    '',
  )
}
