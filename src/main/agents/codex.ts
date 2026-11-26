import { BaseAdapter } from './base'
import { AgentProcess, display, errorMessage, type WireRecord } from './transport'

export class CodexAdapter extends BaseAdapter {
  private process?: AgentProcess
  private threadId?: string
  private turnId?: string
  private items = new Map<string, WireRecord>()

  async start() {
    const { executable, session, env } = this.options
    const resumeId = session.resumeId
    this.process = new AgentProcess(
      executable,
      ['app-server', '--listen', 'stdio://'],
      session.cwd,
      env,
      (record) => this.receive(record),
      (error) => this.emit({ type: 'error', message: error.message }),
    )
    await this.process.call('initialize', {
      clientInfo: { name: 'code_sherpa', title: 'Code Sherpa', version: '0.1.0' },
      capabilities: {
        experimentalApi: true,
        requiredHumanApproval: true,
        requestAttestation: false,
      },
    })
    await this.process.write({ method: 'initialized', params: {} })
    const settings = session.settings?.harness === 'codex' ? session.settings.options : {}
    const { reasoningEffort, ...overrides } = settings
    const params = {
      cwd: session.cwd,
      ...overrides,
      ...(reasoningEffort ? { config: { model_reasoning_effort: reasoningEffort } } : {}),
    }
    const response = resumeId
      ? await this.process.call('thread/resume', {
          ...params,
          threadId: resumeId,
          excludeTurns: true,
        })
      : await this.process.call('thread/start', params)
    this.threadId = response.thread.id
    this.emit({ type: 'session', resumeId: this.threadId, model: response.model })
    if (resumeId && session.messages.length === 0) {
      let cursor: string | null = null
      do {
        const page: WireRecord = await this.process.call('thread/items/list', {
          threadId: this.threadId,
          cursor,
          limit: 100,
          sortDirection: 'asc',
        })
        for (const entry of page.data ?? []) this.item(entry.item, true, true)
        cursor = page.nextCursor ?? null
      } while (cursor)
    }
  }

  async send(text: string) {
    if (!this.process || !this.threadId) throw new Error('Codex is not connected')
    const result = await this.process.call('turn/start', {
      threadId: this.threadId,
      input: [{ type: 'text', text, text_elements: [] }],
    })
    this.turnId = result.turn.id
  }

  private receive(record: WireRecord) {
    if (record.id != null && record.method) {
      void this.request(record).catch((error) =>
        this.emit({ type: 'error', message: errorMessage(error) }),
      )
      return
    }
    const p = record.params ?? {}
    switch (record.method) {
      case 'turn/started':
        this.items.clear()
        this.turnId = p.turn?.id
        this.emit({ type: 'status', status: 'running' })
        break
      case 'item/started':
        this.item(p.item, false)
        break
      case 'item/completed':
        this.item(p.item, true)
        break
      case 'item/agentMessage/delta':
      case 'item/commandExecution/outputDelta':
        if (typeof p.itemId === 'string' && typeof p.delta === 'string') {
          this.emit({ type: 'delta', id: p.itemId, text: p.delta })
        }
        break
      case 'turn/completed':
        this.turnId = undefined
        this.cancelRequests()
        if (p.turn?.error)
          this.emit({ type: 'error', message: p.turn.error.message ?? display(p.turn.error) })
        else this.emit({ type: 'status', status: 'idle' })
        break
      case 'serverRequest/resolved':
        this.pending.get(String(p.requestId))?.({ approved: false })
        break
      case 'error':
        if (p.willRetry) this.message('notice', p.error?.message ?? 'Codex is retrying…')
        else this.emit({ type: 'error', message: p.error?.message ?? display(p) })
        break
    }
  }

  private item(item: WireRecord | undefined, complete: boolean, history = false) {
    if (!item || typeof item.id !== 'string') return
    if (!history) this.items.set(item.id, item)
    const extra = { id: item.id, state: complete ? ('complete' as const) : ('running' as const) }
    switch (item.type) {
      case 'userMessage':
        if (history) this.message('user', contentText(item.content), extra)
        break
      case 'agentMessage':
        this.message('assistant', item.text ?? '', extra)
        break
      case 'commandExecution':
        this.message('tool', item.aggregatedOutput ?? '', {
          ...extra,
          title: 'Run command',
          input: item.command,
          state:
            item.status === 'failed' || (item.exitCode != null && item.exitCode !== 0)
              ? 'error'
              : extra.state,
        })
        break
      case 'fileChange':
        this.message('tool', display(item.changes), {
          ...extra,
          title: 'Edit files',
          state: item.status === 'failed' ? 'error' : extra.state,
        })
        break
      case 'mcpToolCall':
      case 'dynamicToolCall':
        this.message('tool', display(item.result ?? item.contentItems ?? item.error), {
          ...extra,
          title: [item.server, item.tool].filter(Boolean).join(' / '),
          input: display(item.arguments),
          state:
            item.error || item.success === false || item.status === 'failed'
              ? 'error'
              : extra.state,
        })
        break
      case 'webSearch':
        this.message('tool', display(item.action), { ...extra, title: 'Search the web' })
        break
      case 'plan':
        this.message('assistant', item.text ?? '', extra)
        break
      case 'contextCompaction':
        if (complete) this.message('notice', 'Conversation context compacted.', extra)
        break
    }
  }

  private async request(record: WireRecord) {
    const p = record.params ?? {}
    const item = this.items.get(p.itemId)
    const id = String(record.id)
    let result: WireRecord
    if (
      record.method === 'item/commandExecution/requestApproval' ||
      record.method === 'item/fileChange/requestApproval'
    ) {
      const reply = await this.ask({
        id,
        kind: 'approval',
        title: record.method.includes('command')
          ? 'Allow this command?'
          : 'Allow these file changes?',
        detail: [
          p.reason,
          p.command ?? item?.command,
          p.grantRoot ? `Requested write root: ${p.grantRoot}` : undefined,
          display(p.changes ?? item?.changes),
        ]
          .filter(Boolean)
          .join('\n\n'),
      })
      result = { decision: reply.approved ? 'accept' : 'decline' }
    } else if (record.method === 'item/permissions/requestApproval') {
      const reply = await this.ask({
        id,
        kind: 'approval',
        title: 'Allow additional permissions for this turn?',
        approveLabel: 'Allow for this turn',
        detail: [p.reason, display(p.permissions)].filter(Boolean).join('\n\n'),
      })
      result = { permissions: reply.approved ? p.permissions : {}, scope: 'turn' }
    } else if (record.method === 'item/tool/requestUserInput') {
      const questions = (p.questions ?? []).map((q: WireRecord) => ({
        id: q.id,
        label: q.question,
        secret: q.isSecret,
        options: q.options?.map((o: WireRecord) => o.label),
      }))
      const reply = await this.ask({
        id,
        kind: 'question',
        title: 'Codex needs your input',
        questions,
      })
      result = {
        answers: Object.fromEntries(
          questions.map((q: WireRecord) => [
            q.id,
            { answers: reply.approved ? [reply.answers?.[q.id] ?? ''] : [] },
          ]),
        ),
      }
    } else if (record.method === 'mcpServer/elicitation/request') {
      // Complex MCP forms need schema-specific rendering. Explicitly cancel them
      // so unsupported requests never hang or silently approve remote actions.
      this.message(
        'notice',
        `An MCP input request was cancelled because its form is not supported yet. ${p.message ?? ''}`,
      )
      result = { action: 'cancel' }
    } else {
      await this.process?.write({
        id: record.id,
        error: { code: -32601, message: `Unsupported client request: ${record.method}` },
      })
      return
    }
    if (!this.disposed) await this.process?.write({ id: record.id, result })
  }

  async interrupt() {
    this.cancelRequests()
    if (this.turnId)
      await this.process?.call('turn/interrupt', { threadId: this.threadId, turnId: this.turnId })
  }

  override dispose() {
    super.dispose()
    this.process?.dispose()
  }
}

export function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block?.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n')
}
