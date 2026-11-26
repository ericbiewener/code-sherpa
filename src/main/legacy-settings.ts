import { basename } from 'node:path'
import { parse } from 'shell-quote'
import {
  type AgentSettings,
  agentNames,
  type Harness,
  type SettingsMigration,
} from '../shared/types'
import { agentSettingsSchema, configSchema, legacyConfigSchema } from '../shared/validation'

// Compatibility reader only: commands are never accepted by the settings API or launch path.
export function migrateCommand(
  command: string,
  name: string,
  knownHarness?: Harness,
): {
  settings: AgentSettings
  migration?: SettingsMigration
} {
  const issues: string[] = []
  let tokens: string[] = []
  try {
    const parsed = parse(command, (key) => {
      issues.push(
        `Environment variable ${key} needs an explicit executable or native agent configuration.`,
      )
      return `$${key}`
    })
    if (parsed.some((token) => typeof token !== 'string'))
      throw new Error('Shell syntax needs review.')
    tokens = parsed as string[]
  } catch {
    issues.push('The old command could not be converted to integration settings.')
  }
  const [program, ...args] = tokens
  const binary = basename(program ?? '').replace(/\.(exe|cmd|js|mjs|cjs)$/, '')
  const inferred = binary === 'codex' || binary === 'claude' || binary === 'pi' ? binary : undefined
  const harness = knownHarness ?? inferred
  if (!harness) issues.push('Select the integration this executable implements.')
  const options: Record<string, unknown> = {}
  const fields: Record<string, string> =
    harness === 'codex'
      ? {
          '--model': 'model',
          '-m': 'model',
          '--ask-for-approval': 'approvalPolicy',
          '-a': 'approvalPolicy',
          '--sandbox': 'sandbox',
          '-s': 'sandbox',
        }
      : harness === 'claude'
        ? {
            '--model': 'model',
            '--effort': 'effort',
            '--permission-mode': 'permissionMode',
            '--max-turns': 'maxTurns',
          }
        : { '--model': 'model', '--provider': 'provider', '--thinking': 'thinking' }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const equals = arg.indexOf('=')
    const flag = equals < 0 ? arg : arg.slice(0, equals)
    const value = () => (equals < 0 ? args[++i] : arg.slice(equals + 1))
    if (
      harness === 'codex' &&
      (flag === '--dangerously-bypass-approvals-and-sandbox' || flag === '--yolo')
    ) {
      options.approvalPolicy = 'never'
      options.sandbox = 'danger-full-access'
    } else if (harness === 'codex' && flag === '--full-auto') {
      options.approvalPolicy = 'on-request'
      options.sandbox = 'workspace-write'
    } else if (harness === 'claude' && flag === '--dangerously-skip-permissions') {
      options.permissionMode = 'bypassPermissions'
    } else if (harness === 'codex' && (flag === '-c' || flag === '--config')) {
      const override = value() ?? ''
      const match = override.match(
        /^(model|model_reasoning_effort|approval_policy|sandbox_mode)\s*=\s*(?:"([^"\n]+)"|'([^'\n]+)'|([A-Za-z0-9_./:-]+))$/,
      )
      const keys: Record<string, string> = {
        model: 'model',
        model_reasoning_effort: 'reasoningEffort',
        approval_policy: 'approvalPolicy',
        sandbox_mode: 'sandbox',
      }
      if (match) options[keys[match[1]]] = match[2] ?? match[3] ?? match[4]
      else issues.push(`Review configuration override: ${override || flag}`)
    } else if (fields[flag]) {
      const selected = value()
      if (!selected || selected.startsWith('--')) issues.push(`Missing value for ${flag}.`)
      else options[fields[flag]] = fields[flag] === 'maxTurns' ? Number(selected) : selected
    } else {
      issues.push(`Unsupported argument: ${arg}`)
    }
  }
  const common = {
    name: name && name !== command.slice(0, 80) ? name : agentNames[harness ?? 'codex'],
    harness: harness ?? 'codex',
    ...(program &&
    program !== harness &&
    binary !== 'env' &&
    !issues.some((issue) => issue.startsWith('Environment variable'))
      ? { executable: program }
      : {}),
  }
  if (binary === 'env')
    issues.push('Move environment setup to the agent configuration or an executable wrapper.')
  const validated = agentSettingsSchema.safeParse({ ...common, options })
  if (!validated.success)
    issues.push(
      ...validated.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    )
  const settings = validated.success
    ? validated.data
    : agentSettingsSchema.parse({ ...common, options: {} })
  return {
    settings,
    ...(issues.length
      ? { migration: { command, issues, ...(!harness ? { needsIntegration: true } : {}) } }
      : {}),
  }
}

export function readConfig(input: unknown) {
  if ((input as { version?: unknown } | null)?.version !== 1) return configSchema.parse(input)
  const legacy = legacyConfigSchema.parse(input)
  return configSchema.parse({
    ...legacy,
    version: 2,
    profiles: legacy.profiles.map((profile) => {
      const { settings, migration } = migrateCommand(profile.command, profile.name, profile.harness)
      return { id: profile.id, ...settings, ...(migration ? { migration } : {}) }
    }),
  })
}
