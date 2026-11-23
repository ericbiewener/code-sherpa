import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, readlink, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { AppConfig, CommandSettings, Harness } from '../shared/types'
import { commandSettingsSchema, configSchema } from '../shared/validation'
import { inferHarness } from './commands'

export function defaultConfig(): AppConfig {
  return {
    version: 1,
    profiles: [],
  }
}

export function configFilePath(env: NodeJS.ProcessEnv): string {
  const override = env.SHERPA_CONFIG_FILE
  if (override) {
    if (!isAbsolute(override)) throw new Error('SHERPA_CONFIG_FILE must be an absolute path')
    return override
  }
  const root =
    env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME)
      ? env.XDG_CONFIG_HOME
      : join(env.HOME ?? homedir(), '.config')
  return join(root, 'code-sherpa', 'config.json')
}

export class ConfigStore {
  private writes = Promise.resolve()
  private mutations = Promise.resolve()
  private blocked = false
  private lastRead: string | null | undefined
  constructor(readonly path: string) {}

  async load(): Promise<AppConfig> {
    try {
      const text = await readFile(this.path, 'utf8')
      if (text.length > 1024 * 1024) throw new Error('Configuration exceeds 1 MB')
      const config = configSchema.parse(JSON.parse(text))
      this.lastRead = text
      this.blocked = false
      return config
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.blocked = false
        this.lastRead = null
        const config = defaultConfig()
        await this.save(config)
        return config
      }
      this.blocked = true
      throw new Error(
        `Could not load ${this.path}. The file is unchanged. Fix it and retry. ${String(error)}`,
      )
    }
  }

  private update(change: (config: AppConfig) => void): Promise<AppConfig> {
    const mutation = this.mutations
      .catch(() => {})
      .then(async () => {
        const config = await this.load()
        change(config)
        await this.save(config)
        return config
      })
    this.mutations = mutation.then(() => {})
    void this.mutations.catch(() => {})
    return mutation
  }

  addCommand(input: CommandSettings, env: NodeJS.ProcessEnv): Promise<AppConfig> {
    const settings = commandSettingsSchema.parse(input)
    const { command } = settings
    const name = settings.name || command.slice(0, 80)
    const harness = inferHarness(command, env)
    return this.update((config) => {
      if (config.profiles.some((profile) => profile.command === command && profile.name === name))
        return
      config.profiles.push({
        id: randomUUID(),
        name,
        command,
        ...(harness ? { harness } : {}),
      })
    })
  }

  updateCommand(id: string, input: CommandSettings, env: NodeJS.ProcessEnv): Promise<AppConfig> {
    const settings = commandSettingsSchema.parse(input)
    const { command } = settings
    const name = settings.name || command.slice(0, 80)
    const harness = inferHarness(command, env)
    return this.update((config) => {
      const profile = config.profiles.find((p) => p.id === id)
      if (!profile) throw new Error('Command no longer exists')
      if (config.profiles.some((p) => p.id !== id && p.command === command && p.name === name))
        throw new Error('This command is already saved')
      profile.name = name
      if (profile.command === command) return
      profile.command = command
      // A changed executable may speak a different protocol. Ask again for wrappers
      // rather than retaining a potentially incorrect adapter.
      if (harness) profile.harness = harness
      else delete profile.harness
    })
  }

  deleteCommand(id: string): Promise<AppConfig> {
    return this.update((config) => {
      const index = config.profiles.findIndex((p) => p.id === id)
      if (index === -1) throw new Error('Command no longer exists')
      config.profiles.splice(index, 1)
      if (config.defaultProfileId === id) delete config.defaultProfileId
    })
  }

  setHarness(id: string, harness: Harness): Promise<AppConfig> {
    return this.update((config) => {
      const profile = config.profiles.find((p) => p.id === id)
      if (!profile) throw new Error('Command no longer exists')
      profile.harness = harness
    })
  }

  save(input: AppConfig): Promise<void> {
    if (this.blocked)
      return Promise.reject(
        new Error(
          'Fix the configuration file and reload it before saving. The original file has been preserved.',
        ),
      )
    const config = configSchema.parse(input)
    const write = this.writes
      .catch(() => {})
      .then(async () => {
        // Preserve dotfile symlinks: update their target instead of replacing the link.
        const target = await resolveConfigTarget(this.path)
        const current = await readFile(target, 'utf8').catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return null
          throw error
        })
        if (this.lastRead !== undefined && current !== this.lastRead) {
          throw new Error(
            'The configuration changed on disk. Reload from file before saving so external changes are not overwritten.',
          )
        }
        const text = `${JSON.stringify(config, null, 2)}\n`
        await mkdir(dirname(target), { recursive: true, mode: 0o700 })
        await writeFile(`${target}.tmp`, text, { mode: 0o600 })
        await rename(`${target}.tmp`, target)
        this.lastRead = text
      })
    this.writes = write
    return write
  }
}

async function resolveConfigTarget(path: string, depth = 0): Promise<string> {
  if (depth > 40) throw new Error('The configuration symlink contains a cycle')
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  return info?.isSymbolicLink()
    ? resolveConfigTarget(resolve(dirname(path), await readlink(path)), depth + 1)
    : path
}
