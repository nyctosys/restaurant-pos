import { Component, type ReactNode, type ErrorInfo } from 'react';
import log from '../utils/logger';

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

export default class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { hasError: false, error: null, errorInfo: null };

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    this.setState({ errorInfo });
    log.error('ErrorBoundary', error.message, { stack: error.stack, componentStack: errorInfo.componentStack });
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: 32, fontFamily: 'monospace', background: '#1a1a2e', color: '#eee', minHeight: '100vh' }}>
          <h1 style={{ color: '#e94560', fontSize: 24 }}>Application Error</h1>
          <p style={{ color: '#ff6b6b', marginTop: 8 }}>{this.state.error?.message}</p>
          <pre style={{ marginTop: 16, padding: 16, background: '#16213e', borderRadius: 8, overflow: 'auto', fontSize: 12, color: '#0f0', maxHeight: '40vh' }}>
            {this.state.error?.stack}
          </pre>
          {this.state.errorInfo?.componentStack && (
            <pre style={{ marginTop: 12, padding: 16, background: '#16213e', borderRadius: 8, overflow: 'auto', fontSize: 12, color: '#a8dadc', maxHeight: '30vh' }}>
              {this.state.errorInfo.componentStack}
            </pre>
          )}
          <button
            onClick={() => { localStorage.clear(); window.location.href = '/'; }}
            style={{ marginTop: 24, padding: '12px 24px', background: '#e94560', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 14, fontWeight: 'bold' }}
          >
            Clear Storage &amp; Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
