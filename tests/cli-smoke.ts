// Opt-in: connects to real local harnesses but never sends a model prompt.
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { AgentProcess } from '../src/main/agents/transport'
import { discoverHarnesses, shellEnvironment } from '../src/main/discovery'

const env = await shellEnvironment()
const installed = await discoverHarnesses(env)
for (const harness of installed) {
  if (!harness.executable) {
    console.log(`${harness.name}: not installed`)
    continue
  }
  console.log(`${harness.name}: ${harness.version}`)
  if (harness.id === 'claude') {
    let release!: () => void
    const wait = new Promise<void>((resolve) => {
      release = resolve
    })
    async function* empty(): AsyncGenerator<SDKUserMessage> {
      await wait
      yield { type: 'user', message: { role: 'user', content: '' } } as SDKUserMessage
    }
    const active = query({
      prompt: empty(),
      options: {
        pathToClaudeCodeExecutable: harness.executable,
        cwd: process.cwd(),
        env,
        settingSources: ['user', 'project', 'local'],
        permissionMode: 'default',
      },
    })
    const timer = setTimeout(() => {
      release()
      active.close()
    }, 30_000)
    try {
      await active.initializationResult()
      console.log('  SDK initialization succeeded (no prompt sent).')
    } finally {
      clearTimeout(timer)
      release()
      active.close()
    }
  } else {
    const child = new AgentProcess(
      harness.executable,
      harness.id === 'codex'
        ? ['app-server', '--listen', 'stdio://']
        : ['--mode', 'rpc', '--no-session'],
      process.cwd(),
      env,
      (record) => {
        if (record.id != null && record.method)
          console.log(`  Startup interaction: ${record.method}`)
      },
      (error) => console.error(error.message),
    )
    try {
      if (harness.id === 'codex') {
        await child.call('initialize', {
          clientInfo: { name: 'code_sherpa_smoke', title: 'Code Sherpa check', version: '0.1.0' },
          capabilities: {
            experimentalApi: true,
            requestAttestation: false,
            requiredHumanApproval: true,
          },
        })
        await child.write({ method: 'initialized', params: {} })
        const result = await child.call('thread/start', {
          cwd: process.cwd(),
          ephemeral: true,
        })
        if (!result.thread?.id) throw new Error('Missing Codex thread ID')
      } else {
        const result = await child.call('get_state', {}, 'pi')
        if (!result.sessionId) throw new Error('Missing Pi session ID')
      }
      console.log('  Native protocol initialization succeeded (no prompt sent).')
    } finally {
      child.dispose()
    }
  }
}
