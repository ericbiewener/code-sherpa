import { afterEach, beforeEach, expect, it } from 'vitest'
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigStore, configFilePath, defaultConfig } from '../src/main/config'
import { inferHarness, inspectProfiles, parseCommand, resolveCommand } from '../src/main/commands'
import { configSchema } from '../src/shared/validation'

const legacyConfig = {
  version: 1 as const,
  defaultProfileId: 'codex',
  profiles: [
    { id: 'codex', name: 'Work', harness: 'codex' as const, command: 'codex --profile work' },
  ],
}
let directory: string
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'sherpa-config-'))
})
afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

it('keeps configuration outside installation/session storage and supports XDG and explicit paths', () => {
  expect(configFilePath({ HOME: directory, SHERPA_DATA_DIR: '/a/different/app-profile' })).toBe(
    join(directory, '.config/code-sherpa/config.json'),
  )
  expect(configFilePath({ XDG_CONFIG_HOME: directory })).toBe(
    join(directory, 'code-sherpa/config.json'),
  )
  expect(configFilePath({ SHERPA_CONFIG_FILE: join(directory, 'dotfiles/sherpa.json') })).toBe(
    join(directory, 'dotfiles/sherpa.json'),
  )
  expect(() => configFilePath({ SHERPA_CONFIG_FILE: './relative.json' })).toThrow('absolute')
})

it('starts empty and persists added commands independently of the app installation', async () => {
  const path = join(directory, 'config.json')
  const store = new ConfigStore(path)
  expect(await store.load()).toEqual({ version: 1, profiles: [] })
  const config = await store.addCommand({ command: '  codex --profile work  ', name: '' }, {})
  expect(config.profiles).toHaveLength(1)
  expect(config.profiles[0]).toMatchObject({ command: 'codex --profile work', harness: 'codex' })
  expect(await new ConfigStore(path).load()).toEqual(config)
  expect(await readFile(path, 'utf8')).toContain('\n  "version": 1,\n')
  expect(
    (await store.addCommand({ command: 'codex --profile work', name: '' }, {})).profiles,
  ).toHaveLength(1)
})

it('stores a display name separately from the exact quoted launch command', async () => {
  const path = join(directory, 'config.json')
  const store = new ConfigStore(path)
  const command =
    'codex -c "model=gpt-6-luna" -c "model_reasoning_effort=medium" --dangerously-bypass-approvals-and-sandbox'
  const config = await store.addCommand({ name: '  Luna  ', command }, {})
  expect(config.profiles[0]).toMatchObject({ name: 'Luna', command, harness: 'codex' })
  expect(await new ConfigStore(path).load()).toEqual(config)
})

it('renames wrappers without changing their launch command or chosen harness', async () => {
  const store = new ConfigStore(join(directory, 'config.json'))
  const {
    profiles: [profile],
  } = await store.addCommand({ name: 'Work', command: 'my-agent --work' }, {})
  await store.setHarness(profile.id, 'pi')
  await store.updateCommand(profile.id, { name: 'Luna', command: profile.command }, {})
  expect((await store.load()).profiles[0]).toEqual({ ...profile, name: 'Luna', harness: 'pi' })
  await store.updateCommand(profile.id, { name: '', command: profile.command }, {})
  expect((await store.load()).profiles[0]).toEqual({
    ...profile,
    name: profile.command,
    harness: 'pi',
  })
})

it('allows different names for the same command while rejecting duplicate entries', async () => {
  const store = new ConfigStore(join(directory, 'config.json'))
  const {
    profiles: [first],
  } = await store.addCommand({ name: 'Luna', command: 'codex' }, {})
  const second = await store.addCommand({ name: 'Sol', command: 'codex' }, {})
  expect(second.profiles).toHaveLength(2)
  expect((await store.addCommand({ name: 'Luna', command: 'codex' }, {})).profiles).toHaveLength(2)
  await expect(
    store.updateCommand(first.id, { name: 'Sol', command: 'codex' }, {}),
  ).rejects.toThrow('already saved')
  expect((await store.load()).profiles).toEqual(second.profiles)
})

it('preserves existing profiles and disk edits when appending commands', async () => {
  const path = join(directory, 'config.json')
  await writeFile(path, JSON.stringify(legacyConfig))
  const store = new ConfigStore(path)
  expect(await store.load()).toEqual(legacyConfig)
  const external = {
    ...legacyConfig,
    profiles: [...legacyConfig.profiles, { id: 'custom', name: 'Custom', command: '~/bin/agent' }],
  }
  await writeFile(path, JSON.stringify(external))
  await Promise.all([
    store.addCommand({ command: 'claude', name: '' }, {}),
    store.addCommand({ command: 'pi', name: '' }, {}),
  ])
  const saved = await store.load()
  expect(saved.defaultProfileId).toBe('codex')
  expect(saved.profiles.slice(0, 2)).toEqual(external.profiles)
  expect(saved.profiles.map((p) => p.command)).toEqual([
    'codex --profile work',
    '~/bin/agent',
    'claude',
    'pi',
  ])
})

it('saves an unknown wrapper before its harness is chosen, without requiring an installed executable', async () => {
  const store = new ConfigStore(join(directory, 'config.json'))
  const config = await store.addCommand(
    { command: '~/bin/my-agent --work', name: '' },
    { HOME: directory },
  )
  expect(config.profiles[0].harness).toBeUndefined()
  await store.setHarness(config.profiles[0].id, 'pi')
  expect((await store.load()).profiles[0]).toMatchObject({
    command: '~/bin/my-agent --work',
    harness: 'pi',
  })
  await expect(store.setHarness('missing', 'codex')).rejects.toThrow('no longer exists')
})

it('edits commands through dotfile symlinks, preserving their IDs and unrelated settings', async () => {
  const target = join(directory, 'dotfile.json')
  const path = join(directory, 'config.json')
  await writeFile(target, JSON.stringify(legacyConfig))
  await symlink(target, path)
  const store = new ConfigStore(path)
  await store.load()
  const external = {
    ...legacyConfig,
    profiles: [...legacyConfig.profiles, { id: 'other', name: 'Other', command: 'claude' }],
  }
  await writeFile(target, JSON.stringify(external))
  await store.updateCommand('codex', { command: '  pi --work  ', name: 'Work' }, {})
  const saved = await new ConfigStore(path).load()
  expect(saved.defaultProfileId).toBe('codex')
  expect(saved.profiles).toEqual([
    { id: 'codex', name: 'Work', command: 'pi --work', harness: 'pi' },
    external.profiles[1],
  ])
  expect((await lstat(path)).isSymbolicLink()).toBe(true)
})

it('re-detects edited commands and clears a stale harness for unknown wrappers', async () => {
  const store = new ConfigStore(join(directory, 'config.json'))
  const {
    profiles: [profile],
  } = await store.addCommand({ command: 'codex', name: '' }, {})
  await store.updateCommand(profile.id, { command: 'my-agent', name: '' }, {})
  expect((await store.load()).profiles[0]).toMatchObject({
    id: profile.id,
    name: 'my-agent',
    command: 'my-agent',
  })
  expect((await store.load()).profiles[0].harness).toBeUndefined()
  await store.setHarness(profile.id, 'claude')
  await store.updateCommand(profile.id, { command: 'my-agent', name: '' }, {})
  expect((await store.load()).profiles[0].harness).toBe('claude')
})

it('rejects duplicate and invalid edits without losing the original command', async () => {
  const path = join(directory, 'config.json')
  const store = new ConfigStore(path)
  const {
    profiles: [profile],
  } = await store.addCommand({ command: 'codex', name: '' }, {})
  await store.addCommand({ command: 'pi', name: '' }, {})
  const original = await readFile(path, 'utf8')
  await expect(store.updateCommand(profile.id, { command: 'pi', name: '' }, {})).rejects.toThrow(
    'already saved',
  )
  expect(() => store.updateCommand(profile.id, { command: 'codex | cat', name: '' }, {})).toThrow(
    'wrapper',
  )
  expect(() => store.updateCommand(profile.id, { command: '', name: '' }, {})).toThrow()
  expect(() =>
    store.updateCommand(profile.id, { command: 'codex', name: 'x'.repeat(81) }, {}),
  ).toThrow('80 characters')
  expect(() =>
    store.updateCommand(profile.id, { command: 'codex', name: 'Luna\nWork' }, {}),
  ).toThrow('single-line name')
  await expect(store.updateCommand('missing', { command: 'claude', name: '' }, {})).rejects.toThrow(
    'no longer exists',
  )
  expect(await readFile(path, 'utf8')).toBe(original)
})

it('deletes legacy default commands, including the last entry, without replacing the symlink', async () => {
  const path = join(directory, 'config.json')
  const target = join(directory, 'dotfile.json')
  await writeFile(target, JSON.stringify(legacyConfig))
  await symlink(target, path)
  const store = new ConfigStore(path)
  await store.addCommand({ command: 'pi', name: '' }, {})
  await store.deleteCommand('codex')
  const saved = await new ConfigStore(path).load()
  expect(saved.defaultProfileId).toBeUndefined()
  expect(saved.profiles.map((profile) => profile.command)).toEqual(['pi'])
  await expect(store.deleteCommand('missing')).rejects.toThrow('no longer exists')
  await store.deleteCommand(saved.profiles[0].id)
  expect(await new ConfigStore(path).load()).toEqual({ version: 1, profiles: [] })
  expect((await lstat(path)).isSymbolicLink()).toBe(true)
})

it.each([false, true])(
  'preserves dotfile symlinks, including missing targets (%s)',
  async (missingTarget) => {
    const target = join(directory, 'dotfiles', 'sherpa.json')
    await mkdir(join(directory, 'dotfiles'))
    if (!missingTarget) await writeFile(target, JSON.stringify(defaultConfig()))
    const path = join(directory, 'config.json')
    await symlink('dotfiles/sherpa.json', path)
    await new ConfigStore(path).addCommand({ command: 'pi', name: '' }, {})
    expect((await lstat(path)).isSymbolicLink()).toBe(true)
    expect(JSON.parse(await readFile(target, 'utf8')).profiles[0].command).toBe('pi')
  },
)

it('preserves invalid configuration and refuses to overwrite external changes', async () => {
  const path = join(directory, 'config.json')
  await writeFile(path, '{broken')
  const store = new ConfigStore(path)
  await expect(store.load()).rejects.toThrow('unchanged')
  await expect(store.save(defaultConfig())).rejects.toThrow('preserved')
  await expect(store.addCommand({ command: 'pi', name: '' }, {})).rejects.toThrow('unchanged')
  expect(await readFile(path, 'utf8')).toBe('{broken')
  await writeFile(path, JSON.stringify(defaultConfig()))
  const config = await store.load()
  await writeFile(path, JSON.stringify(legacyConfig))
  await expect(store.save(config)).rejects.toThrow('changed on disk')
  expect(await store.load()).toEqual(legacyConfig)
})

it('validates duplicate IDs, invalid harnesses, and multiline commands while accepting empty settings', () => {
  expect(configSchema.parse(defaultConfig()).profiles).toEqual([])
  expect(() => configSchema.parse({ ...defaultConfig(), defaultProfileId: 'missing' })).toThrow(
    'existing default',
  )
  expect(() =>
    configSchema.parse({
      version: 1,
      profiles: [legacyConfig.profiles[0], legacyConfig.profiles[0]],
    }),
  ).toThrow('unique')
  expect(() =>
    configSchema.parse({
      version: 1,
      profiles: [{ ...legacyConfig.profiles[0], harness: 'guess' }],
    }),
  ).toThrow()
  expect(() =>
    configSchema.parse({
      version: 1,
      profiles: [{ ...legacyConfig.profiles[0], command: 'codex\nother' }],
    }),
  ).toThrow('single-line')
})

it.each([
  ['codex --profile work', 'codex'],
  ['"/path with spaces/claude" --model sonnet', 'claude'],
  ['~/bin/pi', 'pi'],
  ['env MY_SETTING=work claude', 'claude'],
  ['~/bin/claude-or-pi-wrapper', undefined],
])('identifies only unambiguous commands (%s)', (command, harness) => {
  expect(inferHarness(command, { HOME: directory })).toBe(harness)
})

it('parses quoted arguments and resolves custom executable paths without a shell', async () => {
  const executable = join(directory, 'my custom agent')
  await writeFile(executable, '#!/bin/sh\nexit 0\n')
  await chmod(executable, 0o755)
  const env = { HOME: directory, PATH: directory, AGENT_PROFILE: 'work' }
  expect(
    resolveCommand('"~/my custom agent" --profile "$AGENT_PROFILE" --label "two words"', env),
  ).toEqual({ executable, args: ['--profile', 'work', '--label', 'two words'] })
  expect(parseCommand('codex --label "a;b"', env).args).toEqual(['--label', 'a;b'])
  expect(() => parseCommand('codex | cat', env)).toThrow('wrapper')
  expect(() => parseCommand('codex; echo no', env)).toThrow('wrapper')
  expect(() => resolveCommand('./agent', env)).toThrow('absolute')
  expect(
    inspectProfiles([{ id: 'missing', name: 'Missing', command: 'codex' }], env)[0],
  ).toMatchObject({ harness: 'codex', error: expect.stringContaining('Could not find') })
})
