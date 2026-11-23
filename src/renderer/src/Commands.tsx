import { useState } from 'react'
import { ArrowRight, Loader2, Pencil, Plus, Trash2 } from 'lucide-react'
import type { AppState, Harness, ProfileInfo, SherpaAPI } from '../../shared/types'
import { agentNames, cleanError, customCommandName } from './ui'

interface Props {
  state: AppState
  api: SherpaAPI
  onState: (state: AppState) => void
  onStarted: (id: string) => void
}

export function Commands({ state, api, onState, onStarted }: Props) {
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<string>()
  const [command, setCommand] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [untyped, setUntyped] = useState<ProfileInfo>()
  const [harness, setHarness] = useState<Harness | ''>('')
  const actionsDisabled = busy || adding || !!editing || !!state.configError

  function cancelEdit() {
    setAdding(false)
    setEditing(undefined)
    setCommand('')
    setName('')
    setError('')
  }

  async function save(event: React.FormEvent) {
    event.preventDefault()
    if (busy || !command.trim()) return
    setBusy(true)
    setError('')
    try {
      const settings = { name: name.trim(), command: command.trim() }
      if (editing) await api.updateCommand(editing, settings)
      else await api.addCommand(settings)
      onState(await api.getState())
      cancelEdit()
    } catch (error) {
      setError(cleanError(error))
    } finally {
      setBusy(false)
    }
  }

  async function remove(profile: ProfileInfo) {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await api.deleteCommand(profile.id)
      onState(await api.getState())
      if (untyped?.id === profile.id) setUntyped(undefined)
    } catch (error) {
      setError(cleanError(error))
    } finally {
      setBusy(false)
    }
  }

  async function launch(profile: ProfileInfo, chosen?: Harness) {
    if (busy) return
    if (!profile.harness && !chosen) {
      setUntyped(profile)
      setHarness('')
      return
    }
    setBusy(true)
    setError('')
    try {
      const id = await api.createSession({
        profileId: profile.id,
        cwd: state.defaultCwd,
        ...(chosen ? { harness: chosen } : {}),
      })
      onState(await api.getState())
      onStarted(id)
    } catch (error) {
      setError(cleanError(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="commands-page">
      <header className="commands-heading">
        <h1>Agent commands</h1>
        <button
          className="secondary-button"
          aria-label="Add command"
          disabled={actionsDisabled}
          onClick={() => {
            setAdding(true)
            setError('')
            setUntyped(undefined)
          }}
        >
          <Plus size={16} />
          Add
        </button>
      </header>
      {state.configError && (
        <div className="inline-error" role="alert">
          {state.configError}
          <button
            onClick={() => void api.reloadConfig().catch((error) => setError(cleanError(error)))}
          >
            Retry
          </button>
        </div>
      )}
      <ul className="command-list" aria-label="Saved commands">
        {state.profiles.map((profile) => (
          <li key={profile.id}>
            {editing === profile.id ? (
              <CommandEditor
                name={name}
                onNameChange={setName}
                command={command}
                busy={busy}
                onChange={setCommand}
                onSave={save}
                onCancel={cancelEdit}
              />
            ) : (
              <div className="command-row">
                <button
                  className="command-launch"
                  aria-label={customCommandName(profile.name, profile.command) || profile.command}
                  title={profile.command}
                  disabled={actionsDisabled}
                  onClick={() => void launch(profile)}
                >
                  <span className="command-label">
                    {customCommandName(profile.name, profile.command) && (
                      <strong>{profile.name}</strong>
                    )}
                    <code>{profile.command}</code>
                  </span>
                  <ArrowRight size={16} aria-hidden="true" />
                </button>
                <button
                  className="icon-button command-action"
                  aria-label={`Edit ${customCommandName(profile.name, profile.command) || profile.command}`}
                  title="Edit command"
                  disabled={actionsDisabled}
                  onClick={() => {
                    setEditing(profile.id)
                    setCommand(profile.command)
                    setName(customCommandName(profile.name, profile.command))
                    setError('')
                    setUntyped(undefined)
                  }}
                >
                  <Pencil size={15} />
                </button>
                <button
                  className="icon-button command-action command-delete"
                  aria-label={`Delete ${customCommandName(profile.name, profile.command) || profile.command}`}
                  title="Delete command"
                  disabled={actionsDisabled}
                  onClick={() => void remove(profile)}
                >
                  <Trash2 size={15} />
                </button>
              </div>
            )}
            {untyped?.id === profile.id && (
              <form
                className="harness-choice"
                onSubmit={(event) => {
                  event.preventDefault()
                  if (harness) void launch(profile, harness)
                }}
              >
                <label>
                  Which agent does this command run?
                  <select
                    aria-label="Agent type"
                    required
                    value={harness}
                    onChange={(event) => setHarness(event.target.value as Harness)}
                  >
                    <option value="" disabled>
                      Choose an agent
                    </option>
                    {(['codex', 'claude', 'pi'] as const).map((type) => (
                      <option key={type} value={type}>
                        {agentNames[type]}
                      </option>
                    ))}
                  </select>
                </label>
                <button className="primary-button" disabled={!harness || busy}>
                  Start
                </button>
              </form>
            )}
          </li>
        ))}
      </ul>
      {!state.profiles.length && !adding && !state.configError && (
        <p className="empty-commands">No commands saved.</p>
      )}
      {adding && (
        <CommandEditor
          name={name}
          onNameChange={setName}
          command={command}
          busy={busy}
          onChange={setCommand}
          onSave={save}
          onCancel={cancelEdit}
        />
      )}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}

function CommandEditor({
  name,
  onNameChange,
  command,
  busy,
  onChange,
  onSave,
  onCancel,
}: {
  name: string
  onNameChange: (value: string) => void
  command: string
  busy: boolean
  onChange: (value: string) => void
  onSave: (event: React.FormEvent) => Promise<void>
  onCancel: () => void
}) {
  return (
    <form
      className="command-editor"
      onSubmit={(event) => void onSave(event)}
      aria-busy={busy}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !busy) onCancel()
      }}
    >
      <label>
        Name
        <input
          autoFocus
          value={name}
          maxLength={80}
          placeholder="Optional, e.g. Luna"
          disabled={busy}
          onChange={(event) => onNameChange(event.target.value)}
        />
      </label>
      <label>
        Command
        <input
          aria-label="Agent command"
          className="command-input"
          placeholder="e.g. codex --profile work"
          value={command}
          maxLength={8192}
          spellCheck={false}
          disabled={busy}
          onChange={(event) => onChange(event.target.value)}
        />
      </label>
      <div className="command-editor-actions">
        <button className="primary-button" disabled={busy || !command.trim()}>
          {busy && <Loader2 size={15} className="spin" />}Save
        </button>
        <button type="button" className="secondary-button" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  )
}
