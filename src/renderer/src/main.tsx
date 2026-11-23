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

const root = document.getElementById('root')
if (!root) throw new Error('Missing app root element')

createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
