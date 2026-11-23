import { afterEach, describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { AgentProcess, JsonLines } from '../src/main/agents/transport'

const fixture = fileURLToPath(new URL('./fixtures/agent.mjs', import.meta.url))
const processes: AgentProcess[] = []
afterEach(() => {
  processes.splice(0).forEach((process) => process.dispose())
})

describe('JSONL transport', () => {
  it('handles split UTF-8, multiple records, CRLF, and Unicode line separators', () => {
    const values: unknown[] = []
    const parser = new JsonLines((record) => values.push(record))
    const input = Buffer.from(
      JSON.stringify({ text: 'Hello 🏔\u2028next\u2029line' }) +
        '\r\n' +
        JSON.stringify({ ok: true }) +
        '\n',
    )
    for (const byte of input) parser.push(Buffer.from([byte]))
    expect(values).toEqual([{ text: 'Hello 🏔\u2028next\u2029line' }, { ok: true }])
  })

  it('correlates out-of-order responses and rejects timed-out requests', async () => {
    const agent = new AgentProcess(
      process.execPath,
      [fixture],
      process.cwd(),
      process.env,
      () => {},
      () => {},
    )
    processes.push(agent)
    const first = agent.call('echo', { name: 'first', delay: 40 })
    const second = agent.call('echo', { name: 'second' })
    expect((await second).name).toBe('second')
    expect((await first).name).toBe('first')
    await expect(agent.call('hang', {}, 'jsonrpc', 20)).rejects.toThrow('timed out')
  })

  it('fails pending requests on malformed output and missing executables', async () => {
    const failures: string[] = []
    const agent = new AgentProcess(
      process.execPath,
      [fixture],
      process.cwd(),
      process.env,
      () => {},
      (error) => failures.push(error.message),
    )
    processes.push(agent)
    await expect(agent.call('malformed')).rejects.toThrow('Invalid agent output')
    expect(failures).toHaveLength(1)
    const missing = new AgentProcess(
      '/not/a/real/agent',
      [],
      process.cwd(),
      process.env,
      () => {},
      () => {},
    )
    processes.push(missing)
    await expect(missing.call('initialize')).rejects.toThrow('ENOENT')
  })
})
