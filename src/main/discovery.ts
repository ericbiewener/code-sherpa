import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'
import { type HarnessInfo, harnesses } from '../shared/types'

const exec = promisify(execFile)
export const names = { codex: 'Codex', claude: 'Claude Code', pi: 'Pi' }

export async function shellEnvironment(): Promise<NodeJS.ProcessEnv> {
  const env = { ...process.env }
  // Finder-launched apps don't inherit the terminal's PATH or provider variables.
  if (process.platform !== 'win32') {
    try {
      const { stdout } = await exec(process.env.SHELL || '/bin/zsh', ['-ilc', '/usr/bin/env -0'], {
        timeout: 8000,
        maxBuffer: 1024 * 1024,
        encoding: 'utf8',
      })
      for (const entry of stdout.split('\0')) {
        const equal = entry.indexOf('=')
        const key = entry.slice(0, equal)
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) env[key] = entry.slice(equal + 1)
      }
    } catch {
      /* inherited environment and common installation locations still work */
    }
  }
  env.PATH = [
    ...new Set(
      [
        ...(env.PATH ?? '').split(delimiter),
        join(homedir(), '.local/bin'),
        join(homedir(), '.pi/agent/bin'),
        '/opt/homebrew/bin',
        '/usr/local/bin',
        '/usr/bin',
        '/bin',
      ].filter(Boolean),
    ),
  ].join(delimiter)
  delete env.ELECTRON_RUN_AS_NODE
  delete env.CLAUDECODE
  return env
}

export async function discoverHarnesses(env: NodeJS.ProcessEnv): Promise<HarnessInfo[]> {
  return Promise.all(
    harnesses.map(async (id): Promise<HarnessInfo> => {
      for (const directory of (env.PATH ?? '').split(delimiter)) {
        for (const suffix of process.platform === 'win32' ? ['.exe', '.cmd', ''] : ['']) {
          const executable = join(directory, id + suffix)
          try {
            await access(executable, constants.X_OK)
          } catch {
            continue
          }
          try {
            const { stdout } = await exec(executable, ['--version'], {
              env,
              timeout: 8000,
              maxBuffer: 64_000,
            })
            return { id, name: names[id], executable, version: stdout.trim().split('\n')[0] }
          } catch (error) {
            return {
              id,
              name: names[id],
              error: `Found ${executable}, but --version failed: ${String(error)}`,
            }
          }
        }
      }
      return {
        id,
        name: names[id],
        error: `Install ${id} and sign in from your terminal, then refresh.`,
      }
    }),
  )
}
