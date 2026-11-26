import { ArrowRight, GitPullRequest, MessageSquare } from 'lucide-react'
import { useId } from 'react'
import type { Session } from '../../shared/types'
import { agentNames, statusLabels } from './ui'

export function SessionHistory({
  sessions,
  title,
  label,
  busy,
  onResume,
}: {
  sessions: Session[]
  title: string
  label: string
  busy: boolean
  onResume: (id: string) => void
}) {
  const titleId = useId()
  if (!sessions.length) return null
  return (
    <section className="session-history" aria-labelledby={titleId}>
      <h2 id={titleId}>{title}</h2>
      <ul aria-label={label}>
        {sessions.map((session) => {
          const Icon = session.prUrl ? GitPullRequest : MessageSquare
          return (
            <li key={session.id}>
              <button
                type="button"
                className="session-resume"
                disabled={busy}
                onClick={() => onResume(session.id)}
              >
                <Icon size={18} />
                <span className="session-summary">
                  <strong>{session.title}</strong>
                  <span>
                    {session.settings?.name || session.profileName || agentNames[session.harness]}
                    {' · '}
                    <time dateTime={new Date(session.updatedAt).toISOString()}>
                      {new Date(session.updatedAt).toLocaleString()}
                    </time>
                  </span>
                </span>
                <span className="session-resume-action">
                  <span className="session-history-status" data-status={session.status}>
                    {statusLabels[session.status]}
                  </span>
                  <span className="session-resume-label">
                    Resume <ArrowRight size={16} />
                  </span>
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
