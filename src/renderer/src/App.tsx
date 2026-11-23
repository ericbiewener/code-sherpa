import { useCallback, useEffect, useState } from 'react'
import type { AppState } from '../../shared/types'
import { Commands } from './Commands'
import { Conversation } from './Conversation'
import { cleanError } from './ui'

export function App() {
  const api = window.sherpa
  const [state, setState] = useState<AppState>()
  const [selected, setSelected] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState('')
  const perform = useCallback(async (action: () => Promise<unknown>) => {
    try {
      await action()
    } catch (error) {
      setError(cleanError(error))
    }
  }, [])

  useEffect(() => {
    if (!api) return
    let mounted = true
    let received = false
    const unsubscribe = api.onState((state) => {
      received = true
      setState(state)
    })
    void api
      .getState()
      .then((state) => {
        if (mounted && !received) setState(state)
      })
      .catch((error) => {
        if (mounted) setError(cleanError(error))
      })
    return () => {
      mounted = false
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    if (!api || selected) return
    const refresh = () => {
      void perform(() => api.reloadConfig())
    }
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [selected, perform])

  if (!api)
    return (
      <main className="boot-screen">
        Open the desktop app with <code>pnpm dev</code>.
      </main>
    )
  if (!state) return <main className="boot-screen">{error || 'Loading…'}</main>
  const active = state.sessions.find((session) => session.id === selected)

  return (
    <main className="app-shell">
      <div className="window-drag" />
      {error && (
        <div className="inline-error" role="alert">
          {error}
          <button type="button" onClick={() => setError('')}>
            Dismiss
          </button>
        </div>
      )}
      {state.storageError && (
        <div className="inline-error" role="alert">
          {state.storageError}
        </div>
      )}
      {active ? (
        <Conversation
          session={active}
          api={api}
          draft={draft}
          onDraft={setDraft}
          perform={perform}
          onBack={() =>
            void perform(async () => {
              await api.closeSession(active.id)
              setSelected(null)
              setDraft('')
              await api.reloadConfig()
            })
          }
        />
      ) : (
        <Commands
          state={state}
          api={api}
          onState={setState}
          onStarted={(id) => {
            setSelected(id)
            setDraft('')
            setError('')
          }}
        />
      )}
    </main>
  )
}

export type Perform = (action: () => Promise<unknown>) => Promise<void>
