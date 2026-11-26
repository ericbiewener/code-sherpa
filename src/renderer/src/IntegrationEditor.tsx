import { Loader2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import {
  type AgentProfile,
  type AgentSettings,
  agentConfigDirectories,
  agentNames,
  claudeEfforts,
  codexEfforts,
  type Harness,
  harnesses,
  piThinkingLevels,
} from '../../shared/types'
import { agentSettingsSchema } from '../../shared/validation'
import { cleanError } from './ui'

export function IntegrationEditor({
  profile,
  focusName = false,
  busy,
  onSave,
  onCancel,
}: {
  profile?: AgentProfile
  focusName?: boolean
  busy: boolean
  onSave: (settings: AgentSettings) => Promise<void>
  onCancel: () => void
}) {
  const [harness, setHarness] = useState<Harness | ''>(
    profile?.migration?.needsIntegration ? '' : (profile?.harness ?? ''),
  )
  const [name, setName] = useState(profile?.name ?? '')
  const nameInput = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (focusName) {
      nameInput.current?.focus()
      nameInput.current?.select()
    }
  }, [focusName])
  const [executable, setExecutable] = useState(profile?.executable ?? '')
  const [configDir, setConfigDir] = useState(profile?.configDir ?? '')
  const [options, setOptions] = useState<Record<string, string | number | undefined>>({
    ...profile?.options,
  })
  const [error, setError] = useState('')
  const option = (key: string, value: string | number) =>
    setOptions((current) => ({ ...current, [key]: value === '' ? undefined : value }))
  const select = (
    label: string,
    key: string,
    choices: readonly (string | readonly [string, string])[],
  ) => (
    <label>
      {label}
      <select
        aria-label={label}
        value={options[key] ?? ''}
        onChange={(event) => option(key, event.target.value)}
      >
        <option value="">Agent default</option>
        {choices.map((choice) => {
          const [value, title] = typeof choice === 'string' ? [choice, choice] : choice
          return (
            <option key={value} value={value}>
              {title}
            </option>
          )
        })}
      </select>
    </label>
  )
  return (
    <form
      className="integration-editor"
      aria-busy={busy}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !busy) onCancel()
      }}
      onSubmit={async (event) => {
        event.preventDefault()
        if (busy) return
        setError('')
        const parsed = agentSettingsSchema.safeParse({
          name,
          harness,
          ...(executable.trim() ? { executable: executable.trim() } : {}),
          ...(configDir.trim() ? { configDir: configDir.trim() } : {}),
          options,
        })
        if (!parsed.success) {
          setError(parsed.error.issues.map((issue) => issue.message).join('. '))
          return
        }
        try {
          await onSave(parsed.data)
        } catch (error) {
          setError(cleanError(error))
        }
      }}
    >
      <fieldset disabled={busy}>
        <label>
          Integration
          <select
            aria-label="Integration"
            required
            value={harness}
            onChange={(event) => {
              setHarness(event.target.value as Harness)
              setOptions({})
              setConfigDir('')
              setError('')
            }}
          >
            <option value="" disabled>
              Choose an integration
            </option>
            {harnesses.map((type) => (
              <option key={type} value={type}>
                {agentNames[type]}
              </option>
            ))}
          </select>
        </label>
        {profile?.migration && (
          <div className="migration-notice">
            <p>Review the settings converted from this saved command:</p>
            <code className="legacy-command">{profile.migration.command}</code>
            <ul>
              {[...new Set(profile.migration.issues)].map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
            <p>
              Saving replaces the old command with the settings shown here. Configure any remaining
              options in the agent’s own configuration.
            </p>
          </div>
        )}
        {harness && (
          <>
            <label>
              Name
              <input
                ref={nameInput}
                value={name}
                maxLength={80}
                placeholder={agentNames[harness]}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <p className="settings-hint">
              Blank options use {agentNames[harness]}’s own settings. Changes apply to new sessions.
            </p>
            <div className="settings-grid">
              {harness === 'pi' && (
                <label>
                  Provider
                  <input
                    value={options.provider ?? ''}
                    maxLength={200}
                    placeholder="Agent default"
                    onChange={(event) => option('provider', event.target.value.trim())}
                  />
                </label>
              )}
              <label>
                Model
                <input
                  value={options.model ?? ''}
                  maxLength={200}
                  placeholder="Agent default"
                  onChange={(event) => option('model', event.target.value.trim())}
                />
              </label>
              {harness === 'codex' && (
                <>
                  {select('Reasoning effort', 'reasoningEffort', codexEfforts)}
                  {select('Approval policy', 'approvalPolicy', [
                    ['untrusted', 'Ask for untrusted commands'],
                    ['on-request', 'Ask when needed'],
                    ['never', 'Never ask'],
                  ])}
                  {select('Sandbox', 'sandbox', [
                    ['read-only', 'Read only'],
                    ['workspace-write', 'Write to workspace'],
                    ['danger-full-access', 'Full access'],
                  ])}
                </>
              )}
              {harness === 'claude' && (
                <>
                  {select('Effort', 'effort', claudeEfforts)}
                  {select('Permission mode', 'permissionMode', [
                    ['default', 'Ask for permissions'],
                    ['acceptEdits', 'Accept file edits'],
                    ['plan', 'Plan only'],
                    ['dontAsk', 'Deny unapproved tools'],
                    ['auto', 'Automatic review'],
                    ['bypassPermissions', 'Bypass permissions'],
                  ])}
                  <label>
                    Maximum turns
                    <input
                      type="number"
                      min={1}
                      max={10000}
                      step={1}
                      value={options.maxTurns ?? ''}
                      placeholder="Agent default"
                      onChange={(event) =>
                        option(
                          'maxTurns',
                          event.target.value === '' ? '' : Number(event.target.value),
                        )
                      }
                    />
                  </label>
                </>
              )}
              {harness === 'pi' && select('Thinking level', 'thinking', piThinkingLevels)}
            </div>
            {harness === 'pi' && (
              <p className="settings-hint">
                A provider requires a model. Tool access follows Pi’s configuration and extensions.
              </p>
            )}
            <label>
              Configuration directory ({agentConfigDirectories[harness].variable})
              <input
                aria-label={agentConfigDirectories[harness].variable}
                value={configDir}
                maxLength={4096}
                spellCheck={false}
                placeholder={`Inherited environment or ${agentConfigDirectories[harness].defaultPath}`}
                onChange={(event) => setConfigDir(event.target.value)}
              />
            </label>
            <p className="settings-hint">
              Optional. Use an absolute path or ~/path, without quotes. Leave blank to inherit your
              environment or the agent’s default.
            </p>
            <details className="executable-settings" open={!!profile?.executable}>
              <summary>Executable location</summary>
              <label>
                Executable path
                <input
                  value={executable}
                  maxLength={4096}
                  spellCheck={false}
                  placeholder={`${harness} (from PATH)`}
                  onChange={(event) => setExecutable(event.target.value)}
                />
              </label>
              <p className="settings-hint">
                Optional path to the installed executable. Paths with spaces need no quotes.
              </p>
            </details>
          </>
        )}
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
        <div className="command-editor-actions">
          <button type="submit" className="primary-button" disabled={!harness || busy}>
            {busy && <Loader2 size={15} className="spin" />}Save settings
          </button>
          <button type="button" className="secondary-button" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </fieldset>
    </form>
  )
}
