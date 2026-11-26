import { useCallback, useEffect, useState } from 'react'
import type { AppState, NewSession } from '../../shared/types'
import { Conversation } from './Conversation'
import { Integrations } from './Integrations'
import { type AppPage, Navigation } from './Navigation'
import { cleanError } from './ui'
import { Walkthrough } from './Walkthrough'

export function App() {
  const api = window.sherpa
  const [state, setState] = useState<AppState>()
  const [selected, setSelected] = useState<string | null>(null)
  const [page, setPage] = useState<AppPage>('walkthrough')
  const [pending, setPending] = useState(false)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
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

  const startSession = async (input: NewSession) => {
    if (pending) return
    setPending(true)
    try {
      const id = await api.createSession(input)
      setSelected(id)
      setError('')
      setState(await api.getState())
    } finally {
      setPending(false)
    }
  }

  const navigate = async (nextPage: AppPage) => {
    if (pending) return
    setPending(true)
    try {
      await perform(async () => {
        setSelected(null)
        setError('')
        setPage(nextPage)
        await api.reloadConfig()
      })
    } finally {
      setPending(false)
    }
  }

  const resumeSession = (id: string) => {
    if (pending) return
    setSelected(id)
    setError('')
  }

  return (
    <main className="app-shell">
      <div className="window-drag" />
      <Navigation page={page} disabled={pending} onNavigate={(page) => void navigate(page)} />
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
          key={active.id}
          session={active}
          profiles={state.profiles}
          api={api}
          draft={drafts[active.id] ?? ''}
          onDraft={(text) => setDrafts((current) => ({ ...current, [active.id]: text }))}
          perform={perform}
          backLabel={page === 'walkthrough' ? 'Walkthroughs' : 'Integrations'}
          navigating={pending}
          onBack={() => void navigate(page)}
        />
      ) : page === 'basic' ? (
        <Integrations
          state={state}
          api={api}
          onState={setState}
          onStart={startSession}
          onResume={resumeSession}
        />
      ) : (
        <Walkthrough
          state={state}
          busy={pending}
          onStart={startSession}
          onResume={resumeSession}
          onManageIntegrations={() => void navigate('basic')}
          onReload={() => api.reloadConfig()}
        />
      )}
    </main>
  )
}

export type Perform = (action: () => Promise<unknown>) => Promise<void>
