import { accessSync, constants, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, delimiter, isAbsolute, join } from 'node:path'
import { parse } from 'shell-quote'
import type { AgentProfile, Harness, ProfileInfo } from '../shared/types'
import { errorMessage } from './agents/transport'

export function parseCommand(command: string, env: NodeJS.ProcessEnv) {
  if (!command.trim() || /[\0\r\n]/.test(command)) throw new Error('Enter a single-line command')
  const tokens = parse(command, (key) => env[key] ?? '')
  if (tokens.some((token) => typeof token !== 'string')) {
    throw new Error(
      'Use an executable plus arguments. Put pipes, redirects, or shell functions in an executable wrapper script.',
    )
  }
  const [program, ...args] = tokens as string[]
  if (!program) throw new Error('The command must start with an executable')
  return {
    program: program.startsWith('~/') ? join(env.HOME ?? homedir(), program.slice(2)) : program,
    args,
  }
}

export function resolveCommand(command: string, env: NodeJS.ProcessEnv) {
  const { program, args } = parseCommand(command, env)
  if (!isAbsolute(program) && /[\\/]/.test(program)) {
    throw new Error('Use an absolute executable path, ~/path, or a command available on PATH')
  }
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
  for (const executable of candidates) {
    try {
      accessSync(executable, constants.X_OK)
      if (statSync(executable).isFile()) return { executable, args }
    } catch {
      /* try the next PATH entry */
    }
  }
  throw new Error(
    `Could not find executable "${program}". Update the command or add it to your login shell's PATH.`,
  )
}

export function inferHarness(command: string, env: NodeJS.ProcessEnv): Harness | undefined {
  const { program, args } = parseCommand(command, env)
  let executable = program
  if (basename(executable) === 'env') {
    executable =
      args.find((arg) => !arg.startsWith('-') && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) ?? ''
  }
  const name = basename(executable).replace(/\.(exe|cmd|js|mjs|cjs)$/, '')
  return name === 'codex' || name === 'claude' || name === 'pi' ? name : undefined
}

export function inspectProfiles(profiles: AgentProfile[], env: NodeJS.ProcessEnv): ProfileInfo[] {
  return profiles.map((profile) => {
    let harness = profile.harness
    try {
      harness ??= inferHarness(profile.command, env)
      return { ...profile, harness, executable: resolveCommand(profile.command, env).executable }
    } catch (error) {
      return { ...profile, harness, error: errorMessage(error) }
    }
  })
}
