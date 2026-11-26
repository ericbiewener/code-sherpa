import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  getSessionInfo,
  getSessionMessages,
  type Query,
  query,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import { BaseAdapter } from './base'
import { contentText } from './codex'
import { display, errorMessage, type WireRecord } from './transport'

export class ClaudeAdapter extends BaseAdapter {
  private query?: Query
  private resumeId = this.options.session.resumeId
  private assistantId?: string
  private aborted = false
  private stderr = ''

  async start() {
    const { session, env } = this.options
    if (this.resumeId && session.messages.length === 0) {
      // SDK history readers use the host process environment, not query.options.env.
      // Never read another profile's transcript or mutate the shared host environment.
      if (
        session.settings?.configDir ||
        env.CLAUDE_CONFIG_DIR !== process.env.CLAUDE_CONFIG_DIR ||
        env.HOME !== process.env.HOME
      ) {
        this.message(
          'notice',
          'This session uses a different Claude configuration directory. Its native context will resume when you send a message.',
        )
        return
      }
      const info = await getSessionInfo(this.resumeId, { dir: session.cwd })
      if (!info) {
        // A custom launcher can select a different CLAUDE_CONFIG_DIR/account.
        // Let that command validate the resume ID instead of rejecting a session
        // just because the SDK's local history reader cannot see its transcript.
        this.message(
          'notice',
          'This transcript is not in the default Claude history store. Your configured integration will attempt to resume it when you send a message.',
        )
        return
      }
      const history = await getSessionMessages(this.resumeId, { dir: session.cwd })
      for (const message of history) this.receive(message, true)
    }
  }

  async send(text: string) {
    if (this.query) throw new Error('Claude is already working')
    this.aborted = false
    this.stderr = ''
    const { session, executable, env } = this.options
    const settings = session.settings?.harness === 'claude' ? session.settings.options : {}
    async function* prompt(): AsyncGenerator<SDKUserMessage> {
      yield {
        type: 'user',
        message: { role: 'user', content: text },
        parent_tool_use_id: null,
        session_id: '',
      }
    }
    this.query = query({
      prompt: prompt(),
      options: {
        pathToClaudeCodeExecutable: executable,
        spawnClaudeCodeProcess: (options) => {
          const child = spawn(options.command, options.args, {
            cwd: options.cwd,
            env: options.env,
            signal: options.signal,
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
          })
          child.stderr.on('data', (data: Buffer) => {
            this.stderr = (this.stderr + data.toString()).slice(-8000)
          })
          return child
        },
        cwd: session.cwd,
        env,
        resume: this.resumeId,
        ...settings,
        ...(settings.permissionMode === 'bypassPermissions'
          ? { allowDangerouslySkipPermissions: true }
          : {}),
        includePartialMessages: true,
        settingSources: ['user', 'project', 'local'],
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        canUseTool: async (toolName, input, context) => {
          const questions =
            toolName === 'AskUserQuestion' && Array.isArray(input.questions)
              ? (input.questions as WireRecord[]).map((q) => ({
                  id: q.question,
                  label: q.question,
                  options: q.options?.map((o: WireRecord) => o.label),
                  multiple: q.multiSelect,
                }))
              : undefined
          const reply = await this.ask(
            {
              id: randomUUID(),
              kind: questions ? 'question' : 'approval',
              title: questions
                ? 'Claude needs your input'
                : (context.title ?? `Allow ${toolName}?`),
              detail: questions
                ? undefined
                : [context.decisionReason, display(input)].filter(Boolean).join('\n\n'),
              questions,
            },
            context.signal,
          )
          return reply.approved
            ? {
                behavior: 'allow',
                updatedInput: questions ? { ...input, answers: reply.answers ?? {} } : input,
              }
            : { behavior: 'deny', message: 'The user declined this request.' }
        },
        onElicitation: async () => {
          this.message(
            'notice',
            'An MCP input form was cancelled because this form type is not supported yet.',
          )
          return { action: 'cancel' }
        },
      },
    })
    void this.consume(this.query)
  }

  private async consume(active: Query) {
    let failed = false
    let completed = false
    try {
      for await (const record of active) {
        if (this.disposed) break
        this.receive(record)
        if (record.type === 'result') {
          completed = true
          failed = record.is_error
          if (failed)
            this.emit({
              type: 'error',
              message:
                'errors' in record
                  ? record.errors.join('\n')
                  : 'Claude could not complete the turn.',
            })
        }
      }
      if (!completed && !this.aborted && !this.disposed)
        throw new Error('Claude exited without completing the turn')
    } catch (error) {
      if (!this.aborted) {
        failed = true
        this.emit({
          type: 'error',
          message: [errorMessage(error), this.stderr.trim()].filter(Boolean).join('\n'),
        })
      }
    } finally {
      active.close()
      if (this.query === active) this.query = undefined
      this.cancelRequests()
      if (!failed) this.emit({ type: 'status', status: 'idle' })
    }
  }

  private receive(record: WireRecord, history = false) {
    if (record.type === 'system' && record.subtype === 'init') {
      this.resumeId = record.session_id
      this.emit({ type: 'session', resumeId: this.resumeId, model: record.model })
    }
    if (record.type === 'stream_event') {
      const event = record.event ?? {}
      if (event.type === 'message_start') this.assistantId = event.message.id
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        this.assistantId ??= randomUUID()
        this.emit({ type: 'delta', id: this.assistantId, text: event.delta.text })
      }
      if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
        const tool = event.content_block
        this.message('tool', '', { id: tool.id, title: tool.name, state: 'running' })
      }
    }
    if (record.type === 'assistant') {
      const message = record.message ?? {}
      const text = contentText(message.content)
      if (text)
        this.message('assistant', text, {
          id: message.id ?? record.uuid ?? this.assistantId,
          state: 'complete',
        })
      for (const block of Array.isArray(message.content) ? message.content : []) {
        if (block.type === 'tool_use')
          this.message('tool', '', {
            id: block.id,
            title: block.name,
            input: display(block.input),
            state: history ? 'complete' : 'running',
          })
      }
      this.assistantId = undefined
      if (record.error) this.message('notice', `Claude: ${record.error}`)
    }
    if (record.type === 'user') {
      if (history) {
        const text = contentText(record.message?.content)
        if (text) this.message('user', text, { id: record.uuid })
      }
      for (const block of Array.isArray(record.message?.content) ? record.message.content : []) {
        if (block.type === 'tool_result')
          this.message('tool', contentText(block.content) || display(block.content), {
            id: block.tool_use_id,
            state: block.is_error ? 'error' : 'complete',
          })
      }
    }
  }

  async interrupt() {
    this.aborted = true
    this.cancelRequests()
    await this.query?.interrupt()
  }

  override dispose() {
    super.dispose()
    this.query?.close()
    this.query = undefined
  }
}
