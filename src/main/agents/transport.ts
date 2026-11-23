import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'

// CLI protocols are versioned independently. Keep their untyped wire boundary here;
// adapters normalize records into the shared, typed AgentEvent model.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Harness protocols vary by version.
export type WireRecord = Record<string, any>

export class JsonLines {
  private decoder = new StringDecoder('utf8')
  private buffer = ''
  constructor(private readonly onRecord: (record: WireRecord) => void) {}

  push(chunk: Buffer) {
    this.buffer += this.decoder.write(chunk)
    if (this.buffer.length > 32 * 1024 * 1024) throw new Error('Agent record exceeds 32 MB')
    while (true) {
      const end = this.buffer.indexOf('\n')
      if (end === -1) break
      const line = this.buffer.slice(0, end).trim()
      this.buffer = this.buffer.slice(end + 1)
      if (!line) continue
      const record: unknown = JSON.parse(line)
      if (!record || typeof record !== 'object' || Array.isArray(record)) {
        throw new Error('Agent sent a non-object protocol record')
      }
      this.onRecord(record as WireRecord)
    }
  }
}

interface Pending {
  resolve: (value: WireRecord) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

export class AgentProcess {
  private child: ChildProcessWithoutNullStreams
  private pending = new Map<string, Pending>()
  private sequence = 0
  private stopped = false
  private stderr = ''

  constructor(
    executable: string,
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
    private onRecord: (record: WireRecord) => void,
    private onExit: (error: Error) => void,
  ) {
    this.child = spawn(executable, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    })
    const lines = new JsonLines((record) => this.receive(record))
    this.child.stdout.on('data', (data: Buffer) => {
      if (this.stopped) return
      try {
        lines.push(data)
      } catch (error) {
        this.fail(new Error(`Invalid agent output: ${errorMessage(error)}`))
        this.dispose()
      }
    })
    this.child.stderr.on('data', (data: Buffer) => {
      this.stderr = (this.stderr + data.toString()).slice(-8000)
    })
    this.child.stdin.on('error', (error) => this.fail(error))
    this.child.on('error', (error) => this.fail(error))
    this.child.on('exit', (code, signal) => {
      this.fail(new Error(`Agent exited (${signal ?? code ?? 'unknown'}). ${this.stderr.trim()}`))
    })
  }

  private receive(record: WireRecord) {
    const pending = this.pending.get(String(record.id))
    const isResponse =
      record.type === 'response' || (!record.method && ('result' in record || 'error' in record))
    if (pending && isResponse) {
      this.pending.delete(String(record.id))
      clearTimeout(pending.timer)
      if (record.error || record.success === false) {
        pending.reject(
          new Error(
            typeof record.error === 'string'
              ? record.error
              : (record.error?.message ?? 'Agent request failed'),
          ),
        )
      } else {
        pending.resolve(record.type === 'response' ? (record.data ?? {}) : (record.result ?? {}))
      }
      return
    }
    this.onRecord(record)
  }

  call(
    method: string,
    params: WireRecord = {},
    protocol: 'jsonrpc' | 'pi' = 'jsonrpc',
    timeout = 30_000,
  ): Promise<WireRecord> {
    if (this.stopped) return Promise.reject(new Error('Agent process is closed'))
    const id = `sherpa-${++this.sequence}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Agent timed out handling ${method}`))
      }, timeout)
      this.pending.set(id, { resolve, reject, timer })
      void this.write(
        protocol === 'pi' ? { ...params, id, type: method } : { id, method, params },
      ).catch((error) => {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      })
    })
  }

  write(record: WireRecord): Promise<void> {
    if (this.stopped) return Promise.reject(new Error('Agent process is closed'))
    return new Promise((resolve, reject) => {
      this.child.stdin.write(`${JSON.stringify(record)}\n`, (error) =>
        error ? reject(error) : resolve(),
      )
    })
  }

  private fail(error: Error) {
    if (this.stopped) return
    this.rejectPending(error)
    this.onExit(error)
    this.dispose()
  }

  private rejectPending(error: Error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  dispose() {
    if (this.stopped) return
    this.stopped = true
    this.rejectPending(new Error('Agent process closed'))
    this.child.stdin.end()
    const pid = this.child.pid
    if (!pid) return
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (process.platform === 'win32') this.child.kill(signal)
        else process.kill(-pid, signal)
      } catch {
        /* already exited */
      }
    }
    kill('SIGTERM')
    const timer = setTimeout(() => kill('SIGKILL'), 1500)
    timer.unref()
    this.child.once('close', () => clearTimeout(timer))
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function display(value: unknown): string {
  if (value == null) return ''
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
}
