import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { ConfigStore, configFilePath, defaultConfig } from '../src/main/config'
import { inspectProfiles, resolveExecutable } from '../src/main/integrations'
import { migrateCommand, readConfig } from '../src/main/legacy-settings'
import { agentSettingsSchema, configSchema } from '../src/shared/validation'

const codex = { name: 'Work', harness: 'codex' as const, options: { model: 'test-model' } }
const legacyConfig = {
  version: 1,
  defaultProfileId: 'codex',
  profiles: [
    {
      id: 'codex',
      name: 'Work',
      harness: 'codex',
      command: 'codex --model test-model --dangerously-bypass-approvals-and-sandbox',
    },
  ],
}
let directory: string
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'sherpa-config-'))
})
afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

it('keeps portable configuration outside installation and session storage', () => {
  expect(configFilePath({ HOME: directory, SHERPA_DATA_DIR: '/different' })).toBe(
    join(directory, '.config/code-sherpa/config.json'),
  )
  expect(configFilePath({ XDG_CONFIG_HOME: directory })).toBe(
    join(directory, 'code-sherpa/config.json'),
  )
  expect(configFilePath({ SHERPA_CONFIG_FILE: join(directory, 'custom.json') })).toBe(
    join(directory, 'custom.json'),
  )
  expect(() => configFilePath({ SHERPA_CONFIG_FILE: './relative.json' })).toThrow('absolute')
})

it('persists structured settings and defaults an empty name to the selected integration', async () => {
  const store = new ConfigStore(join(directory, 'config.json'))
  expect(await store.load()).toEqual({ version: 2, profiles: [] })
  const config = await store.addProfile({ ...codex, name: '' })
  expect(config.profiles[0]).toMatchObject({
    name: 'Codex',
    harness: 'codex',
    options: codex.options,
  })
  expect(await new ConfigStore(store.path).load()).toEqual(config)
  expect(await readFile(store.path, 'utf8')).not.toContain('command')
})

it('migrates legacy commands without changing the source until the next save', async () => {
  const store = new ConfigStore(join(directory, 'config.json'))
  const original = JSON.stringify(legacyConfig)
  await writeFile(store.path, original)
  expect((await store.load()).profiles[0]).toEqual({
    id: 'codex',
    ...codex,
    options: {
      model: 'test-model',
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
    },
  })
  expect(await readFile(store.path, 'utf8')).toBe(original)
  await store.addProfile({ name: '', harness: 'pi', options: {} })
  expect((await store.load()).version).toBe(2)
})

it.each([
  [
    'codex -c \'model="example"\' -c \'model_reasoning_effort="medium"\'',
    'codex',
    { model: 'example', reasoningEffort: 'medium' },
  ],
  [
    'codex -c "model=test-model" -c "model_reasoning_effort=medium" -c "approval_policy=never"',
    'codex',
    { model: 'test-model', reasoningEffort: 'medium', approvalPolicy: 'never' },
  ],
  [
    'claude --model sonnet --effort high --dangerously-skip-permissions --max-turns 12',
    'claude',
    { model: 'sonnet', effort: 'high', permissionMode: 'bypassPermissions', maxTurns: 12 },
  ],
  [
    'pi --provider openai --model example --thinking=xhigh',
    'pi',
    { provider: 'openai', model: 'example', thinking: 'xhigh' },
  ],
])('converts supported options: %s', (command, harness, options) => {
  expect(migrateCommand(command, 'Work')).toEqual({ settings: { name: 'Work', harness, options } })
})

it.each([
  'codex --profile work',
  'codex | cat',
  'env FOO=bar codex',
  '$AGENT --model example',
  'codex --sandbox mystery',
])('preserves unsupported legacy configuration for explicit review: %s', (command) => {
  const profile = readConfig({ version: 1, profiles: [{ id: 'old', name: 'Old', command }] })
    .profiles[0]
  expect(profile.migration?.command).toBe(command)
  expect(profile.migration?.issues.length).toBeGreaterThan(0)
  expect(inspectProfiles([profile], {})[0].error).toContain('Review')
})

it('requires unknown legacy executables to choose an integration; known wrappers retain their path', () => {
  expect(migrateCommand('"/path with spaces/my-agent"', 'Old').migration?.needsIntegration).toBe(
    true,
  )
  expect(migrateCommand('"/path with spaces/my-agent"', 'Work', 'pi')).toEqual({
    settings: {
      name: 'Work',
      harness: 'pi',
      executable: '/path with spaces/my-agent',
      options: {},
    },
  })
})

it('preserves external changes and concurrent edits while replacing reviewed settings', async () => {
  const store = new ConfigStore(join(directory, 'config.json'))
  await store.load()
  const external = {
    version: 1,
    defaultProfileId: 'old',
    profiles: [{ id: 'old', name: 'Old', command: 'codex --profile work' }],
  }
  await writeFile(store.path, JSON.stringify(external))
  await Promise.all([
    store.addProfile(codex),
    store.addProfile({ name: 'Pi', harness: 'pi', options: {} }),
  ])
  const saved = await store.load()
  expect(saved.profiles).toHaveLength(3)
  expect(saved.defaultProfileId).toBe('old')
  expect(saved.profiles[0].migration?.command).toBe('codex --profile work')
  await store.updateProfile('old', codex)
  expect((await store.load()).profiles[0]).toEqual({ id: 'old', ...codex })
  expect((await store.load()).profiles.slice(1)).toEqual(saved.profiles.slice(1))
})

it.each([false, true])(
  'preserves dotfile symlinks including missing targets (%s)',
  async (missing) => {
    const target = join(directory, 'dotfiles/config.json')
    await mkdir(join(directory, 'dotfiles'))
    if (!missing) await writeFile(target, JSON.stringify(legacyConfig))
    const path = join(directory, 'config.json')
    await symlink('dotfiles/config.json', path)
    const store = new ConfigStore(path)
    const config = await store.addProfile(codex)
    await store.updateProfile(config.profiles[config.profiles.length - 1].id, {
      ...codex,
      name: 'Edited',
    })
    expect((await lstat(path)).isSymbolicLink()).toBe(true)
    expect(JSON.parse(await readFile(target, 'utf8')).profiles.at(-1).name).toBe('Edited')
    for (const profile of config.profiles) await store.deleteProfile(profile.id)
    expect(await store.load()).toEqual({ version: 2, profiles: [] })
    expect((await lstat(path)).isSymbolicLink()).toBe(true)
  },
)

it('preserves invalid files and refuses to overwrite changes since the last read', async () => {
  const store = new ConfigStore(join(directory, 'config.json'))
  await writeFile(store.path, '{broken')
  await expect(store.load()).rejects.toThrow('unchanged')
  await expect(store.save(defaultConfig())).rejects.toThrow('preserved')
  await expect(store.addProfile(codex)).rejects.toThrow('unchanged')
  expect(await readFile(store.path, 'utf8')).toBe('{broken')
  await writeFile(store.path, JSON.stringify(defaultConfig()))
  const config = await store.load()
  await writeFile(store.path, JSON.stringify(legacyConfig))
  await expect(store.save(config)).rejects.toThrow('changed on disk')
  expect(await store.load()).toEqual(readConfig(legacyConfig))
})

it('validates integration-specific fields and protects existing entries from invalid edits', async () => {
  const store = new ConfigStore(join(directory, 'config.json'))
  const config = await store.addProfile(codex)
  const original = await readFile(store.path, 'utf8')
  expect(() =>
    store.updateProfile(config.profiles[0].id, { ...codex, name: 'x'.repeat(81) }),
  ).toThrow()
  await expect(store.updateProfile('missing', codex)).rejects.toThrow('no longer exist')
  await expect(store.deleteProfile('missing')).rejects.toThrow('no longer exist')
  expect(await readFile(store.path, 'utf8')).toBe(original)
  expect(() =>
    configSchema.parse({ ...config, profiles: [config.profiles[0], config.profiles[0]] }),
  ).toThrow('unique')
  expect(() => configSchema.parse({ ...config, defaultProfileId: 'missing' })).toThrow(
    'existing default',
  )
  for (const input of [
    { ...codex, command: 'codex' },
    { ...codex, harness: 'guess' },
    { ...codex, options: { permissionMode: 'bypassPermissions' } },
    { name: '', harness: 'pi', options: { provider: 'openai' } },
    { name: '', harness: 'claude', options: { maxTurns: 0 } },
  ])
    expect(() => agentSettingsSchema.parse(input)).toThrow()
})

it('resolves literal executable names and paths without interpreting quotes, variables, or arguments', async () => {
  const executable = join(directory, 'my custom agent')
  await writeFile(executable, '#!/bin/sh\nexit 0\n')
  await chmod(executable, 0o755)
  const env = { HOME: directory, PATH: directory }
  expect(resolveExecutable('~/my custom agent', env)).toBe(executable)
  expect(resolveExecutable('my custom agent', env)).toBe(executable)
  expect(() => resolveExecutable('"~/my custom agent"', env)).toThrow()
  expect(() => resolveExecutable('my custom agent --model example', env)).toThrow('Could not find')
  expect(() => resolveExecutable('./agent', env)).toThrow('absolute')
})
