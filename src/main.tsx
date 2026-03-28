import { Component } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

class ErrorBoundary extends Component<{children: any}, {error: any}> {
  constructor(props: any) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error: any) { return { error }; }
  componentDidCatch(error: any, info: any) { console.error('RENDER ERROR:', error, info); }
  render() {
    if (this.state.error) {
      return (
        <div style={{
          position: 'fixed', inset: 0, background: '#0a0a0f', display: 'flex',
          alignItems: 'center', justifyContent: 'center', padding: '40px',
          fontFamily: 'monospace', color: '#ef4444', flexDirection: 'column', gap: '16px',
          zIndex: 99999,
        }}>
          <div style={{ fontSize: '20px', fontWeight: 'bold' }}>Erreur de rendu React</div>
          <pre style={{
            background: '#1a0010', padding: '20px', borderRadius: '8px',
            border: '1px solid #ef444444', maxWidth: '900px', overflowX: 'auto',
            whiteSpace: 'pre-wrap', fontSize: '13px', color: '#fca5a5', lineHeight: 1.6,
          }}>
            {String(this.state.error?.message || this.state.error)}
            {'\n\n'}
            {String(this.state.error?.stack || '').split('\n').slice(0,15).join('\n')}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
)
