import { accessSync, constants, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import {
  type AgentProfile,
  type AgentSettings,
  agentConfigDirectories,
  type ProfileInfo,
} from '../shared/types'
import { errorMessage } from './agents/transport'

export function integrationEnvironment(
  settings: AgentSettings | undefined,
  inherited: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const env = { ...inherited }
  if (settings?.configDir) {
    const home = env.HOME || homedir()
    const directory =
      settings.configDir === '~'
        ? home
        : settings.configDir.startsWith('~/')
          ? join(home, settings.configDir.slice(2))
          : settings.configDir
    if (!isAbsolute(directory))
      throw new Error('Use an absolute configuration directory path or ~/path')
    env[agentConfigDirectories[settings.harness].variable] = directory
  }
  return env
}

// An executable name/path is a single value, never shell syntax or a command line.
export function resolveExecutable(input: string, env: NodeJS.ProcessEnv): string {
  const program = input.startsWith('~/') ? join(env.HOME ?? homedir(), input.slice(2)) : input
  if (!isAbsolute(program) && /[\\/]/.test(program))
    throw new Error('Use an absolute executable path, ~/path, or an executable name on PATH')
  const candidates = isAbsolute(program)
    ? [program]
    : (env.PATH ?? '')
        .split(delimiter)
        .filter(Boolean)
        .flatMap((directory) =>
          (process.platform === 'win32' ? ['.exe', '.cmd', ''] : ['']).map((suffix) =>
            join(directory, program + suffix),
          ),
        )
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK)
      if (statSync(candidate).isFile()) return candidate
    } catch {
      /* try the next PATH entry */
    }
  }
  throw new Error(
    `Could not find executable "${program}". Set its path in the integration settings or add it to your login shell's PATH.`,
  )
}

export function inspectProfiles(profiles: AgentProfile[], env: NodeJS.ProcessEnv): ProfileInfo[] {
  return profiles.map((profile) => {
    try {
      if (profile.migration)
        throw new Error('Review and save this integration’s settings before starting a session.')
      return {
        ...profile,
        resolvedExecutable: resolveExecutable(profile.executable ?? profile.harness, env),
      }
    } catch (error) {
      return { ...profile, error: errorMessage(error) }
    }
  })
}
