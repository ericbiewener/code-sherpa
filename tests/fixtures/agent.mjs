#!/usr/bin/env node
// Deterministic subprocess fixture. Never calls an AI provider or executes a tool.
import { createInterface } from 'node:readline'
import { appendFileSync, writeFileSync } from 'node:fs'

if (process.env.SHERPA_FIXTURE_ARGV)
  writeFileSync(process.env.SHERPA_FIXTURE_ARGV, JSON.stringify(process.argv.slice(2)))

const pi = process.argv.includes('--mode')
const claude = process.argv.includes('--input-format')
const output = (record) => process.stdout.write(JSON.stringify(record) + '\n')
if (process.argv.includes('--version')) {
  console.log('test-harness 1.0')
  process.exit(0)
}
const pending = new Map()
const threadId = 'saved-thread'
const result = (request, data = {}) =>
  output(
    pi
      ? { type: 'response', id: request.id, success: true, command: request.type, data }
      : { id: request.id, result: data },
  )
const notify = (method, params) => output({ method, params })

function finish(text) {
  if (claude) {
    const id = 'claude-message-' + Date.now()
    output({
      type: 'stream_event',
      uuid: id + '-start',
      session_id: 'claude-session',
      event: { type: 'message_start', message: { id } },
    })
    output({
      type: 'stream_event',
      uuid: id + '-delta',
      session_id: 'claude-session',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
    })
    output({
      type: 'assistant',
      uuid: id,
      session_id: 'claude-session',
      parent_tool_use_id: null,
      message: {
        id,
        role: 'assistant',
        content: [{ type: 'text', text }],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    })
    output({
      type: 'result',
      subtype: 'success',
      uuid: id + '-result',
      session_id: 'claude-session',
      is_error: false,
      result: text,
      duration_ms: 10,
      duration_api_ms: 10,
      num_turns: 1,
      total_cost_usd: 0,
      usage: {},
      permission_denials: [],
    })
  } else if (pi) {
    output({
      type: 'tool_execution_start',
      toolCallId: 'pi-tool',
      toolName: 'read',
      args: { path: 'README.md' },
    })
    output({
      type: 'tool_execution_end',
      toolCallId: 'pi-tool',
      toolName: 'read',
      result: { content: [{ type: 'text', text: 'A project readme.' }] },
      isError: false,
    })
    output({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: text } })
    output({
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text }] },
    })
    output({ type: 'agent_end', willRetry: false })
    setTimeout(() => output({ type: 'agent_settled', aborted: false }), 100)
  } else {
    notify('item/started', {
      item: {
        id: 'command-' + Date.now(),
        type: 'commandExecution',
        command: 'cat README.md',
        aggregatedOutput: 'A project readme.',
        status: 'completed',
        exitCode: 0,
      },
    })
    const id = 'assistant-' + Date.now()
    notify('item/started', { item: { id, type: 'agentMessage', text: '' } })
    notify('item/agentMessage/delta', { itemId: id, delta: text.slice(0, 8) })
    setTimeout(() => {
      notify('item/agentMessage/delta', { itemId: id, delta: text.slice(8) })
      notify('item/completed', { item: { id, type: 'agentMessage', text } })
      notify('turn/completed', { turn: { id: 'turn-1', status: 'completed' } })
    }, 40)
  }
}

createInterface({ input: process.stdin })
  .on('line', (line) => {
    const request = JSON.parse(line)
    if (process.env.SHERPA_FIXTURE_TRACE)
      appendFileSync(process.env.SHERPA_FIXTURE_TRACE, JSON.stringify(request) + '\n')
    if (claude) {
      if (request.type === 'control_response') {
        const response = request.response
        pending.get(response.request_id)?.(response.response)
        pending.delete(response.request_id)
        return
      }
      if (request.type === 'control_request') {
        output({
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: request.request_id,
            response: {
              commands: [],
              models: [],
              account: {},
              output_style: 'default',
              available_output_styles: [],
            },
          },
        })
        if (request.request.subtype === 'interrupt') finish('Stopped.')
        return
      }
      if (request.type === 'user') {
        const text = request.message.content
        output({
          type: 'system',
          subtype: 'init',
          session_id: 'claude-session',
          model: 'test-claude',
          tools: [],
          mcp_servers: [],
          permissionMode: 'default',
          apiKeySource: 'test',
        })
        if (text === 'wait') return
        if (text === 'approval' || text === 'question') {
          const question = text === 'question'
          pending.set('claude-request', (response) =>
            finish(
              response.behavior === 'allow'
                ? question
                  ? `You chose ${response.updatedInput.answers['Choose a color']}.`
                  : 'Approved by you.'
                : 'Denied by you.',
            ),
          )
          output({
            type: 'control_request',
            request_id: 'claude-request',
            request: {
              subtype: 'can_use_tool',
              tool_name: question ? 'AskUserQuestion' : 'Bash',
              input: question
                ? {
                    questions: [
                      {
                        question: 'Choose a color',
                        header: 'Color',
                        options: [{ label: 'Green' }, { label: 'Blue' }],
                      },
                    ],
                  }
                : { command: 'cat README.md' },
              tool_use_id: 'claude-tool',
            },
          })
          return
        }
        finish('Hello from **Claude Code**. Your project is ready.')
      }
      return
    }
    if (pending.has(String(request.id))) {
      pending.get(String(request.id))(request)
      pending.delete(String(request.id))
      return
    }
    const method = request.method ?? request.type
    if (method === 'initialized') return
    if (method === 'initialize') return result(request, { userAgent: 'fixture' })
    if (method === 'thread/start' || method === 'thread/resume')
      return result(request, {
        thread: { id: request.params.threadId ?? threadId },
        model: 'test-model',
      })
    if (method === 'thread/items/list')
      return result(
        request,
        request.params.cursor
          ? {
              data: [
                { item: { id: 'old-assistant', type: 'agentMessage', text: 'A previous answer.' } },
              ],
              nextCursor: null,
            }
          : {
              data: [
                {
                  item: {
                    id: 'old-user',
                    type: 'userMessage',
                    content: [{ type: 'text', text: 'A previous question.' }],
                  },
                },
              ],
              nextCursor: 'page-2',
            },
      )
    if (method === 'get_state')
      return result(request, {
        sessionId: 'pi-session',
        sessionFile: '/tmp/pi-session.jsonl',
        model: { provider: 'test', id: 'model' },
      })
    if (method === 'get_messages')
      return result(request, { messages: [{ role: 'user', content: 'Previous Pi question.' }] })
    if (method === 'turn/interrupt' || method === 'abort') {
      pending.clear()
      result(request)
      if (pi) output({ type: 'agent_settled', aborted: true })
      else notify('turn/completed', { turn: { id: 'turn-1', status: 'interrupted' } })
      return
    }
    if (method === 'turn/start' || method === 'prompt') {
      const text = pi ? request.message : request.params.input[0].text
      if (text === 'crash') {
        console.error('Fixture startup failure')
        process.exit(2)
      }
      result(request, pi ? { disposition: 'started' } : { turn: { id: 'turn-1' } })
      if (pi) {
        output({ type: 'agent_start' })
        output({ type: 'message_start', message: { role: 'assistant', content: [] } })
      } else notify('turn/started', { turn: { id: 'turn-1' } })
      if (text === 'wait') return
      if (text === 'approval') {
        pending.set('approve-1', (response) =>
          finish(
            (pi ? response.confirmed : response.result.decision === 'accept')
              ? 'Approved by you.'
              : 'Denied by you.',
          ),
        )
        if (pi)
          output({
            type: 'extension_ui_request',
            id: 'approve-1',
            method: 'confirm',
            title: 'Allow fixture command?',
            message: 'Read README.md',
          })
        else
          output({
            id: 'approve-1',
            method: 'item/commandExecution/requestApproval',
            params: { threadId, command: 'cat README.md', reason: 'Inspect the readme' },
          })
        return
      }
      if (text === 'question') {
        pending.set('question-1', (response) =>
          finish(`You chose ${pi ? response.value : response.result.answers.color.answers[0]}.`),
        )
        if (pi)
          output({
            type: 'extension_ui_request',
            id: 'question-1',
            method: 'select',
            title: 'Choose a color',
            options: ['Green', 'Blue'],
          })
        else
          output({
            id: 'question-1',
            method: 'item/tool/requestUserInput',
            params: {
              questions: [
                {
                  id: 'color',
                  question: 'Choose a color',
                  options: [{ label: 'Green' }, { label: 'Blue' }],
                },
              ],
            },
          })
        return
      }
      finish(`Hello from **${pi ? 'Pi' : 'Codex'}**. Your project is ready.`)
      return
    }
    if (method === 'echo')
      return setTimeout(() => result(request, request.params), request.params.delay ?? 0)
    if (method === 'hang') return
    if (method === 'malformed') return process.stdout.write('{bad json}\n')
    result(request)
  })
  .on('close', () => process.exit(0))
