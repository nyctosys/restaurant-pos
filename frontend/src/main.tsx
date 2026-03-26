import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import ErrorBoundary from './components/ErrorBoundary.tsx'
import log from './utils/logger.ts'

log.info('App', 'Starting', { origin: window.location.origin, apiBase: import.meta.env.VITE_API_URL || '/api' });

window.addEventListener('error', (e) => {
  log.error('Window', e.message, { source: e.filename, line: e.lineno, col: e.colno });
});
window.addEventListener('unhandledrejection', (e) => {
  log.error('Window', 'Unhandled promise rejection', { reason: String(e.reason) });
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
