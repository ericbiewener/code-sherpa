import { ArrowRight, Copy, Pencil, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import type {
  AgentSettings,
  AppState,
  NewSession,
  ProfileInfo,
  SherpaAPI,
} from '../../shared/types'
import { IntegrationEditor } from './IntegrationEditor'
import { SessionHistory } from './SessionHistory'
import { AgentIcon, agentNames, cleanError } from './ui'

interface Props {
  state: AppState
  api: SherpaAPI
  onState: (state: AppState) => void
  onStart: (input: NewSession) => Promise<void>
  onResume: (id: string) => void
}

export function Integrations({ state, api, onState, onStart, onResume }: Props) {
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<{ id: string; focusName?: boolean }>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const actionsDisabled = busy || adding || !!editing || !!state.configError
  function cancelEdit() {
    setAdding(false)
    setEditing(undefined)
    setError('')
  }
  async function save(settings: AgentSettings) {
    setBusy(true)
    try {
      if (editing) await api.updateProfile(editing.id, settings)
      else await api.addProfile(settings)
      onState(await api.getState())
      cancelEdit()
    } finally {
      setBusy(false)
    }
  }
  async function clone(profile: ProfileInfo) {
    if (actionsDisabled) return
    setBusy(true)
    setError('')
    try {
      const id = await api.cloneProfile(profile.id)
      onState(await api.getState())
      setEditing({ id, focusName: true })
    } catch (error) {
      setError(cleanError(error))
    } finally {
      setBusy(false)
    }
  }
  async function remove(profile: ProfileInfo) {
    setBusy(true)
    setError('')
    try {
      await api.deleteProfile(profile.id)
      onState(await api.getState())
    } catch (error) {
      setError(cleanError(error))
    } finally {
      setBusy(false)
    }
  }
  async function launch(profile: ProfileInfo) {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await onStart({ profileId: profile.id, cwd: state.defaultCwd })
    } catch (error) {
      setError(cleanError(error))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="commands-page">
      <header className="commands-heading">
        <h1>Basic Agent Session</h1>
        <button
          type="button"
          className="secondary-button"
          disabled={actionsDisabled}
          onClick={() => {
            setAdding(true)
            setError('')
          }}
        >
          <Plus size={16} />
          Add integration
        </button>
      </header>
      {state.configError && (
        <div className="inline-error" role="alert">
          {state.configError}
          <button
            type="button"
            onClick={() => void api.reloadConfig().catch((error) => setError(cleanError(error)))}
          >
            Retry
          </button>
        </div>
      )}
      <ul className="command-list" aria-label="Saved integrations">
        {state.profiles.map((profile) => (
          <li key={profile.id}>
            {editing?.id === profile.id ? (
              <IntegrationEditor
                profile={profile}
                focusName={editing.focusName}
                busy={busy}
                onSave={save}
                onCancel={cancelEdit}
              />
            ) : (
              <>
                <div className="command-row">
                  <button
                    type="button"
                    className="command-launch"
                    aria-label={profile.name}
                    disabled={actionsDisabled || !!profile.error}
                    onClick={() => void launch(profile)}
                  >
                    <AgentIcon harness={profile.harness} size={28} />
                    <span className="command-label">
                      <strong>{profile.name}</strong>
                      <span>
                        {agentNames[profile.harness]}
                        {profile.options.model ? ` · ${profile.options.model}` : ''}
                      </span>
                    </span>
                    <ArrowRight size={16} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="icon-button command-action"
                    aria-label={`Edit ${profile.name}`}
                    title="Edit settings"
                    disabled={actionsDisabled}
                    onClick={() => {
                      setEditing({ id: profile.id })
                      setError('')
                    }}
                  >
                    <Pencil size={15} />
                  </button>
                  <button
                    type="button"
                    className="icon-button command-action"
                    aria-label={`Clone ${profile.name}`}
                    title="Clone integration"
                    disabled={actionsDisabled}
                    onClick={() => void clone(profile)}
                  >
                    <Copy size={15} />
                  </button>
                  <button
                    type="button"
                    className="icon-button command-action command-delete"
                    aria-label={`Delete ${profile.name}`}
                    title="Delete settings"
                    disabled={actionsDisabled}
                    onClick={() => void remove(profile)}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
                {profile.error && <p className="profile-error">{profile.error}</p>}
              </>
            )}
          </li>
        ))}
      </ul>
      {!state.profiles.length && !adding && !state.configError && (
        <p className="empty-commands">
          No integrations saved. Choose an integration to configure your first agent.
        </p>
      )}
      {adding && <IntegrationEditor busy={busy} onSave={save} onCancel={cancelEdit} />}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      <SessionHistory
        sessions={state.sessions.filter((session) => !session.prUrl)}
        title="Recent sessions"
        label="Saved sessions"
        busy={busy}
        onResume={onResume}
      />
    </section>
  )
}
