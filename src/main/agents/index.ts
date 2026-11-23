import { ClaudeAdapter } from './claude'
import { CodexAdapter } from './codex'
import { PiAdapter } from './pi'
import type { AdapterOptions } from './base'
import type { AgentAdapter } from '../../shared/types'

export function createAdapter(options: AdapterOptions): AgentAdapter {
  switch (options.session.harness) {
    case 'codex':
      return new CodexAdapter(options)
    case 'claude':
      return new ClaudeAdapter(options)
    case 'pi':
      return new PiAdapter(options)
  }
}
