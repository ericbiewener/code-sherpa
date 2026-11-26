import { ArrowRight, GitPullRequest, Loader2 } from 'lucide-react'
import { useState } from 'react'
import type { AppState, NewSession } from '../../shared/types'
import initialPromptGuidelines from './initial-prompt.md?raw'
import { SessionHistory } from './SessionHistory'
import { agentNames, cleanError } from './ui'

export function Walkthrough({
  state,
  busy,
  onStart,
  onResume,
  onManageIntegrations,
  onReload,
}: {
  state: AppState
  busy: boolean
  onStart: (input: NewSession) => Promise<void>
  onResume: (id: string) => void
  onManageIntegrations: () => void
  onReload: () => Promise<void>
}) {
  const [url, setUrl] = useState('')
  const [profileId, setProfileId] = useState(state.config.defaultProfileId ?? '')
  const [error, setError] = useState('')
  const walkthroughs = state.sessions.filter((session) => session.prUrl)
  const profile =
    state.profiles.find((item) => item.id === profileId) ??
    state.profiles.find((item) => item.id === state.config.defaultProfileId) ??
    state.profiles[0]

  async function start(event: React.FormEvent) {
    event.preventDefault()
    if (busy || !profile || state.configError || profile.error) return
    setError('')
    try {
      const prUrl = url.trim()
      const parsed = new URL(prUrl)
      if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) {
        setError('Enter an HTTP or HTTPS pull request URL.')
        return
      }
      await onStart({
        profileId: profile.id,
        cwd: state.defaultCwd,
        prUrl,
        initialPrompt: `${initialPromptGuidelines.trimEnd()}\n\nFetch the full PR diff, title, and body for this URL: ${prUrl}. Summarize the changeset.`,
      })
    } catch (error) {
      setError(cleanError(error))
    }
  }

  return (
    <section className="walkthrough-page">
      <div className="walkthrough-icon">
        <GitPullRequest size={26} strokeWidth={1.6} />
      </div>
      <h1>PR Walkthrough</h1>
      <p className="walkthrough-intro">
        Understand a pull request with your agent. Start with a summary, then ask questions about
        the changes.
      </p>
      {state.configError && (
        <div className="inline-error" role="alert">
          {state.configError}
          <button
            type="button"
            onClick={() => void onReload().catch((e) => setError(cleanError(e)))}
          >
            Retry
          </button>
        </div>
      )}
      <form className="walkthrough-form" onSubmit={(event) => void start(event)} aria-busy={busy}>
        <label>
          PR URL
          <input
            type="url"
            required
            value={url}
            maxLength={8192}
            placeholder="https://github.com/owner/repo/pull/123"
            spellCheck={false}
            autoComplete="off"
            disabled={busy}
            onChange={(event) => {
              setUrl(event.target.value)
              setError('')
            }}
          />
        </label>
        <label>
          Agent settings
          <select
            aria-label="Agent settings"
            required
            value={profile?.id ?? ''}
            disabled={busy || !state.profiles.length || !!state.configError}
            onChange={(event) => {
              setProfileId(event.target.value)
              setError('')
            }}
          >
            {!state.profiles.length && <option value="">No integrations saved</option>}
            {state.profiles.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name} · {agentNames[item.harness]}
              </option>
            ))}
          </select>
        </label>
        {profile?.error && (
          <p className="inline-error" role="alert">
            {profile.error}
          </p>
        )}
        {!state.profiles.length && !state.configError && (
          <p className="empty-commands">Add an integration to start your first walkthrough.</p>
        )}
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
        <div className="walkthrough-actions">
          <button
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={onManageIntegrations}
          >
            Manage integrations
          </button>
          <button
            type="submit"
            className="primary-button"
            disabled={busy || !url.trim() || !profile || !!state.configError || !!profile.error}
          >
            {busy ? <Loader2 size={16} className="spin" /> : <ArrowRight size={16} />}
            {busy ? 'Starting…' : 'Start walkthrough'}
          </button>
        </div>
      </form>
      <SessionHistory
        sessions={walkthroughs}
        title="Recent walkthroughs"
        label="Saved walkthroughs"
        busy={busy}
        onResume={onResume}
      />
    </section>
  )
}
