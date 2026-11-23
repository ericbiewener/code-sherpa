import type { AgentAdapter } from '../../shared/types'
import type { AdapterOptions } from './base'
import { ClaudeAdapter } from './claude'
import { CodexAdapter } from './codex'
import { PiAdapter } from './pi'

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
