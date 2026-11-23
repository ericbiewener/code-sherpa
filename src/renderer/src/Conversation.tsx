import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Check,
  ChevronDown,
  CircleHelp,
  FileCode2,
  Info,
  Loader2,
  ShieldCheck,
  Square,
  Terminal,
  X,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type {
  Interaction,
  InteractionReply,
  Session,
  SherpaAPI,
  TranscriptItem,
} from '../../shared/types'
import type { Perform } from './App'
import { AgentIcon, agentNames, customCommandName, statusLabels } from './ui'

interface Props {
  session: Session
  api: SherpaAPI
  draft: string
  onDraft: (text: string) => void
  perform: Perform
  onBack: () => void
}

export function Conversation({ session, api, draft, onDraft, perform, onBack }: Props) {
  const [sending, setSending] = useState(false)
  const [atBottom, setAtBottom] = useState(true)
  const scroll = useRef<HTMLDivElement>(null)
  const composer = useRef<HTMLTextAreaElement>(null)
  const sticky = useRef(true)
  const busy = ['starting', 'running', 'waiting'].includes(session.status)

  useEffect(() => {
    if (sticky.current) scroll.current?.scrollTo({ top: scroll.current.scrollHeight })
  }, [])
  useEffect(() => {
    if (composer.current) {
      composer.current.style.height = 'auto'
      composer.current.style.height = `${Math.min(composer.current.scrollHeight, 200)}px`
    }
  }, [])
  useEffect(() => {
    composer.current?.focus()
  }, [])

  async function send() {
    if (busy || sending || !draft.trim()) return
    const text = draft.trim()
    setSending(true)
    sticky.current = true
    onDraft('')
    await perform(async () => {
      try {
        await api.sendMessage(session.id, text)
      } catch (error) {
        onDraft(text)
        throw error
      }
    })
    setSending(false)
    composer.current?.focus()
  }

  return (
    <div className="conversation">
      <header className="conversation-header">
        <button type="button" className="secondary-button" onClick={onBack}>
          <ArrowLeft size={15} />
          Commands
        </button>
        <span className="conversation-command" title={session.launchCommand}>
          {customCommandName(session.profileName, session.launchCommand ?? session.harness) ||
            session.launchCommand ||
            session.harness}
        </span>
        <span className={`status-badge ${session.status}`}>{statusLabels[session.status]}</span>
      </header>
      <div
        className="transcript"
        ref={scroll}
        onScroll={() => {
          const element = scroll.current
          if (!element) return
          sticky.current = element.scrollHeight - element.scrollTop - element.clientHeight < 100
          setAtBottom(sticky.current)
        }}
      >
        <div className="transcript-inner">
          {session.messages.map((message) => (
            <Message
              key={message.id}
              message={message}
              harness={session.harness}
              api={api}
              perform={perform}
            />
          ))}
          {busy && !session.interactions.length && (
            <div className="working-indicator">
              <Loader2 size={14} className="spin" />
              {session.status === 'starting'
                ? 'Connecting to your agent…'
                : `${agentNames[session.harness]} is working…`}
            </div>
          )}
          {session.error && (
            <div className="session-error" role="alert">
              <strong>The session needs attention</strong>
              <pre>{session.error}</pre>
              <p>Check your CLI login or configuration, then send a message to reconnect.</p>
            </div>
          )}
        </div>
      </div>
      {!atBottom && (
        <button
          type="button"
          className="jump-bottom secondary-button"
          onClick={() => {
            sticky.current = true
            scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: 'smooth' })
          }}
        >
          <ArrowDown size={14} />
          Latest activity
        </button>
      )}
      <div className="composer-area">
        {session.interactions.map((interaction) => (
          <InteractionCard
            key={interaction.id}
            interaction={interaction}
            onRespond={(reply) => api.respond(session.id, interaction.id, reply)}
            perform={perform}
          />
        ))}
        <div className={`composer ${busy ? 'busy' : ''}`}>
          <textarea
            ref={composer}
            value={draft}
            aria-label="Message your agent"
            placeholder={`Message ${agentNames[session.harness]}…`}
            rows={2}
            onChange={(e) => onDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void send()
              }
            }}
          />
          <div className="composer-bottom">
            <span>
              <AgentIcon harness={session.harness} size={14} />
              {session.model ?? agentNames[session.harness]}
            </span>
            {busy ? (
              <button
                type="button"
                className="stop-button"
                aria-label="Stop turn"
                onClick={() => void perform(() => api.interrupt(session.id))}
              >
                <Square size={12} fill="currentColor" />
                Stop
              </button>
            ) : (
              <button
                type="button"
                className="send-button"
                aria-label="Send message"
                disabled={!draft.trim() || sending}
                onClick={() => void send()}
              >
                <ArrowUp size={19} />
              </button>
            )}
          </div>
        </div>
        <div className="composer-hint">
          <span>
            {busy
              ? 'You can draft your next message while the agent works.'
              : 'Enter to send · Shift + Enter for a new line'}
          </span>
        </div>
      </div>
    </div>
  )
}

function Message({
  message,
  harness,
  api,
  perform,
}: {
  message: TranscriptItem
  harness: Session['harness']
  api: SherpaAPI
  perform: Perform
}) {
  if (message.role === 'notice')
    return (
      <div className="notice-message">
        <Info size={13} />
        <span>{message.text}</span>
      </div>
    )
  if (message.role === 'tool')
    return (
      <details className={`tool-message ${message.state}`}>
        <summary>
          {message.state === 'running' ? (
            <Loader2 size={14} className="spin" />
          ) : message.state === 'error' ? (
            <X size={14} />
          ) : (
            <Check size={14} />
          )}
          <span>{message.title || 'Tool result'}</span>
          {message.input && <code>{toolSummary(message.input)}</code>}
          <ChevronDown size={14} />
        </summary>
        <div className="tool-body">
          {message.input && (
            <>
              <div className="tool-label">
                <Terminal size={12} />
                INPUT
              </div>
              <pre>{message.input}</pre>
            </>
          )}
          {message.text && (
            <>
              <div className="tool-label">
                <FileCode2 size={12} />
                OUTPUT
              </div>
              <pre>{message.text}</pre>
            </>
          )}
          {!message.text && !message.input && (
            <p>{message.state === 'running' ? 'Waiting for output…' : 'No output returned.'}</p>
          )}
        </div>
      </details>
    )
  if (!message.text && message.role === 'assistant') return null
  return (
    <article className={`message ${message.role}`}>
      <div className="message-meta">
        {message.role === 'assistant' && (
          <span className={harness}>
            <AgentIcon harness={harness} size={15} />
          </span>
        )}
        <strong>{message.role === 'user' ? 'You' : agentNames[harness]}</strong>
        <time>
          {new Date(message.createdAt).toLocaleTimeString([], {
            hour: 'numeric',
            minute: '2-digit',
          })}
        </time>
      </div>
      <div className="message-content">
        {message.role === 'user' ? (
          <p>{message.text}</p>
        ) : (
          <Markdown
            remarkPlugins={[remarkGfm]}
            components={{
              a: ({ href, children }) => (
                <a
                  href={href}
                  onClick={(event) => {
                    event.preventDefault()
                    if (href) void perform(() => api.openExternal(href))
                  }}
                >
                  {children}
                </a>
              ),
              img: ({ alt }) => (
                <span className="image-placeholder">[Image: {alt ?? 'image'}]</span>
              ),
            }}
          >
            {message.text}
          </Markdown>
        )}
      </div>
    </article>
  )
}

function toolSummary(input: string) {
  try {
    const value = JSON.parse(input)
    return String(value.command ?? value.file_path ?? value.path ?? value.pattern ?? input).slice(
      0,
      100,
    )
  } catch {
    return input.split('\n')[0].slice(0, 100)
  }
}

function InteractionCard({
  interaction,
  onRespond,
  perform,
}: {
  interaction: Interaction
  onRespond: (reply: InteractionReply) => Promise<void>
  perform: Perform
}) {
  const [answers, setAnswers] = useState<Record<string, string>>(() =>
    Object.fromEntries((interaction.questions ?? []).map((q) => [q.id, q.defaultValue ?? ''])),
  )
  const [busy, setBusy] = useState(false)
  const isQuestion = interaction.kind === 'question'
  async function respond(approved: boolean) {
    setBusy(true)
    await perform(() => onRespond({ approved, answers }))
    setBusy(false)
  }
  return (
    <section
      className="interaction-card"
      aria-label={isQuestion ? 'Agent question' : 'Approval request'}
    >
      <div className="interaction-heading">
        {isQuestion ? <CircleHelp size={18} /> : <ShieldCheck size={18} />}
        <strong>{interaction.title}</strong>
        <span>YOUR INPUT</span>
      </div>
      {interaction.detail && <pre className="interaction-detail">{interaction.detail}</pre>}
      {interaction.questions?.map((q) => (
        <div className="question" key={q.id}>
          <label htmlFor={`question-${interaction.id}-${q.id}`}>{q.label}</label>
          {q.options && (
            <div className="question-options">
              {q.options.map((option) => (
                <button
                  type="button"
                  key={option}
                  disabled={busy}
                  className={
                    (
                      q.multiple
                        ? (answers[q.id] ?? '').split(', ').includes(option)
                        : answers[q.id] === option
                    )
                      ? 'chosen'
                      : ''
                  }
                  onClick={() =>
                    setAnswers((old) => {
                      const selected = (old[q.id] ?? '').split(', ').filter(Boolean)
                      return {
                        ...old,
                        [q.id]: q.multiple
                          ? (selected.includes(option)
                              ? selected.filter((x) => x !== option)
                              : [...selected, option]
                            ).join(', ')
                          : option,
                      }
                    })
                  }
                >
                  {option}
                </button>
              ))}
            </div>
          )}
          {q.multiline ? (
            <textarea
              id={`question-${interaction.id}-${q.id}`}
              rows={5}
              value={answers[q.id] ?? ''}
              onChange={(e) => setAnswers((old) => ({ ...old, [q.id]: e.target.value }))}
              disabled={busy}
            />
          ) : (
            <input
              id={`question-${interaction.id}-${q.id}`}
              type={q.secret ? 'password' : 'text'}
              value={answers[q.id] ?? ''}
              onChange={(e) => setAnswers((old) => ({ ...old, [q.id]: e.target.value }))}
              placeholder={q.options ? 'Choose above, or write your own answer' : 'Your answer'}
              disabled={busy}
            />
          )}
        </div>
      ))}
      <div className="interaction-actions">
        <button
          type="button"
          className="secondary-button"
          disabled={busy}
          onClick={() => void respond(false)}
        >
          {isQuestion ? 'Cancel' : 'Deny'}
        </button>
        <button
          type="button"
          className="primary-button"
          disabled={
            busy || (isQuestion && interaction.questions?.some((q) => !answers[q.id]?.trim()))
          }
          onClick={() => void respond(true)}
        >
          {busy && <Loader2 size={14} className="spin" />}
          {isQuestion ? 'Send answer' : (interaction.approveLabel ?? 'Allow once')}
        </button>
      </div>
    </section>
  )
}
