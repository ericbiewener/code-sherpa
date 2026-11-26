import { GitPullRequest, Menu, Terminal } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

const pages = [
  { id: 'walkthrough', label: 'PR Walkthrough', icon: GitPullRequest },
  { id: 'basic', label: 'Basic Agent Session', icon: Terminal },
] as const

export type AppPage = (typeof pages)[number]['id']

export function Navigation({
  page,
  disabled,
  onNavigate,
}: {
  page: AppPage
  disabled: boolean
  onNavigate: (page: AppPage) => void
}) {
  const [open, setOpen] = useState(false)
  const container = useRef<HTMLDivElement>(null)
  const toggle = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const dismiss = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false)
    }
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false)
        toggle.current?.focus()
      }
    }
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('keydown', dismissOnEscape)
    return () => {
      document.removeEventListener('pointerdown', dismiss)
      document.removeEventListener('keydown', dismissOnEscape)
    }
  }, [open])

  return (
    <header className="app-header">
      <div className="navigation" ref={container}>
        <button
          ref={toggle}
          type="button"
          className="icon-button navigation-toggle"
          aria-label="Navigation menu"
          aria-expanded={open}
          aria-controls="app-navigation"
          disabled={disabled}
          onClick={() => setOpen(!open)}
        >
          <Menu size={20} />
        </button>
        {open && (
          <nav id="app-navigation" className="navigation-menu" aria-label="Features">
            {pages.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                aria-current={page === id ? 'page' : undefined}
                disabled={disabled}
                onClick={() => {
                  setOpen(false)
                  toggle.current?.focus()
                  onNavigate(id)
                }}
              >
                <Icon size={17} />
                {label}
              </button>
            ))}
          </nav>
        )}
      </div>
      <span className="app-name">Code Sherpa</span>
      <span className="feature-name">{pages.find((item) => item.id === page)?.label}</span>
    </header>
  )
}
