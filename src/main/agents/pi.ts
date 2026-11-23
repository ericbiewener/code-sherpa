import { BaseAdapter } from './base'
import { contentText } from './codex'
import { AgentProcess, display, errorMessage, type WireRecord } from './transport'

export class PiAdapter extends BaseAdapter {
  private process?: AgentProcess
  private assistantId?: string
  private hadError = false
  private lastError = ''

  async start() {
    const { executable, session, env } = this.options
    const resumeId = session.resumeId
    const args = [...(this.options.args ?? []), '--mode', 'rpc']
    if (resumeId) args.push('--session', resumeId)
    if (session.model) args.push('--model', session.model)
    this.process = new AgentProcess(
      executable,
      args,
      session.cwd,
      env,
      (record) => this.receive(record),
      (error) => this.emit({ type: 'error', message: error.message }),
    )
    await this.syncState()
    if (resumeId && session.messages.length === 0) {
      const history = await this.process.call('get_messages', {}, 'pi')
      for (const m of history.messages ?? []) {
        if (m.role === 'user' || m.role === 'assistant')
          this.message(m.role, contentText(m.content), { state: 'complete' })
        if (m.role === 'toolResult')
          this.message('tool', contentText(m.content), {
            id: m.toolCallId,
            title: m.toolName,
            state: m.isError ? 'error' : 'complete',
          })
      }
    }
  }

  private async syncState() {
    const state = await this.process!.call('get_state', {}, 'pi')
    this.emit({
      type: 'session',
      resumeId: state.sessionFile ?? state.sessionId,
      model: state.model ? `${state.model.provider}/${state.model.id}` : undefined,
    })
  }

  async send(text: string) {
    this.hadError = false
    this.lastError = ''
    const result = await this.process!.call('prompt', { message: text }, 'pi')
    if (result.disposition === 'handled') {
      await this.syncState()
      this.emit({ type: 'status', status: 'idle' })
    }
  }

  private receive(record: WireRecord) {
    switch (record.type) {
      case 'agent_start':
        this.emit({ type: 'status', status: 'running' })
        break
      case 'message_start':
        if (record.message?.role === 'assistant')
          this.assistantId = this.message('assistant', '', { state: 'running' })
        break
      case 'message_update':
        if (record.assistantMessageEvent?.type === 'text_delta') {
          this.assistantId ??= this.message('assistant', '', { state: 'running' })
          this.emit({
            type: 'delta',
            id: this.assistantId,
            text: record.assistantMessageEvent.delta,
          })
        }
        break
      case 'message_end':
        if (record.message?.role === 'assistant') {
          this.message('assistant', contentText(record.message.content), {
            id: this.assistantId,
            state: 'complete',
          })
          this.assistantId = undefined
          if (record.message.stopReason === 'error') {
            this.hadError = true
            this.lastError = record.message.errorMessage ?? 'Pi provider request failed'
          } else {
            this.hadError = false
            this.lastError = ''
          }
        }
        break
      case 'tool_execution_start':
        this.message('tool', '', {
          id: record.toolCallId,
          title: record.toolName,
          input: display(record.args),
          state: 'running',
        })
        break
      case 'tool_execution_update':
      case 'tool_execution_end':
        this.message(
          'tool',
          contentText((record.result ?? record.partialResult)?.content) ||
            display(record.result ?? record.partialResult),
          {
            id: record.toolCallId,
            title: record.toolName,
            state:
              record.type === 'tool_execution_update'
                ? 'running'
                : record.isError
                  ? 'error'
                  : 'complete',
          },
        )
        break
      case 'agent_settled':
        this.cancelRequests()
        if (this.hadError) this.emit({ type: 'error', message: this.lastError })
        else {
          this.emit({ type: 'status', status: 'idle' })
          void this.syncState().catch((error) =>
            this.emit({ type: 'error', message: errorMessage(error) }),
          )
        }
        break
      case 'auto_retry_start':
        this.message(
          'notice',
          `Retrying (${record.attempt}/${record.maxAttempts}): ${record.errorMessage}`,
        )
        break
      case 'extension_error':
        this.message('notice', `Extension error: ${record.error}`)
        break
      case 'extension_ui_request':
        void this.extensionRequest(record).catch((error) =>
          this.emit({ type: 'error', message: errorMessage(error) }),
        )
        break
    }
  }

  private async extensionRequest(record: WireRecord) {
    if (record.method === 'notify') {
      this.message('notice', record.message ?? '')
      return
    }
    if (!['confirm', 'select', 'input', 'editor'].includes(record.method)) return
    const controller = new AbortController()
    const timer =
      typeof record.timeout === 'number'
        ? setTimeout(() => controller.abort(), record.timeout)
        : undefined
    const reply = await this.ask(
      {
        id: record.id,
        kind: record.method === 'confirm' ? 'approval' : 'question',
        title: record.title ?? 'Pi needs your input',
        detail: record.message,
        questions:
          record.method === 'confirm'
            ? undefined
            : [
                {
                  id: 'value',
                  label: record.title ?? 'Your response',
                  options: record.options,
                  multiline: record.method === 'editor',
                  defaultValue: record.prefill,
                },
              ],
      },
      controller.signal,
    )
    clearTimeout(timer)
    if (this.disposed || controller.signal.aborted) return
    await this.process?.write({
      type: 'extension_ui_response',
      id: record.id,
      ...(record.method === 'confirm'
        ? { confirmed: reply.approved }
        : reply.approved
          ? { value: reply.answers?.value ?? '' }
          : { cancelled: true }),
    })
  }

  async interrupt() {
    this.cancelRequests()
    await this.process?.call('abort', {}, 'pi')
  }

  override dispose() {
    super.dispose()
    this.process?.dispose()
  }
}
