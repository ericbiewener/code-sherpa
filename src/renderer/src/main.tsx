import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'
import type { SherpaAPI } from '../../shared/types'

declare global {
  interface Window {
    sherpa?: SherpaAPI
  }
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
