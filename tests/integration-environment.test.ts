import { join } from 'node:path'
import { expect, it } from 'vitest'
import { integrationEnvironment } from '../src/main/integrations'
import { agentConfigDirectories, harnesses } from '../src/shared/types'
import { agentSettingsSchema } from '../src/shared/validation'

it.each(harnesses)(
  'isolates %s environment overrides, expands ~/ paths, and retains inherited variables',
  (harness) => {
    const inherited = {
      HOME: '/home/example',
      PATH: '/bin',
      CODEX_HOME: '/codex',
      CLAUDE_CONFIG_DIR: '/claude',
      PI_CODING_AGENT_DIR: '/pi',
    }
    const before = { ...inherited }
    const settings = { name: 'Work', harness, options: {}, configDir: '~/agent with spaces' }
    const overridden = integrationEnvironment(settings, inherited)
    expect(overridden).toEqual({
      ...before,
      [agentConfigDirectories[harness].variable]: join(inherited.HOME, 'agent with spaces'),
    })
    expect(inherited).toEqual(before)
    expect(integrationEnvironment({ ...settings, configDir: undefined }, inherited)).toEqual(before)
    expect(
      integrationEnvironment({ ...settings, configDir: '~' }, inherited)[
        agentConfigDirectories[harness].variable
      ],
    ).toBe(inherited.HOME)
  },
)

it('validates configuration directories without treating them as shell expressions', () => {
  for (const configDir of ['/tmp/config with spaces', '~/.codex-work', '~'])
    expect(
      agentSettingsSchema.parse({ name: '', harness: 'codex', options: {}, configDir }).configDir,
    ).toBe(configDir)
  for (const configDir of [
    './relative',
    '$HOME/.codex',
    '"/tmp/config"',
    '/tmp/config\nother',
    '/tmp/config\0',
  ])
    expect(() =>
      agentSettingsSchema.parse({ name: '', harness: 'codex', options: {}, configDir }),
    ).toThrow()
  expect(() =>
    integrationEnvironment({ name: '', harness: 'codex', options: {}, configDir: 'relative' }, {}),
  ).toThrow('absolute')
})
