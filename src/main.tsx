import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { ErrorBoundary } from './components/ErrorBoundary'
import { applyInitialTheme } from './lib/theme'

// Avant le premier rendu : la page s'affiche directement dans le bon thème.
applyInitialTheme()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* Dernier filet : si même l'appli entière plante, on affiche un message au lieu d'une page blanche. */}
    <ErrorBoundary fullScreen>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
