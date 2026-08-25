import { Component, type ErrorInfo, type ReactNode } from 'react';
import { BRIDGE_HTTP } from './api';

/**
 * Catch a render crash and SHOW it.
 *
 * Without this, React 18 unmounts the entire tree on an uncaught render error
 * and #root is left empty — which on this app means the page paints for an
 * instant and then goes to the body's #0b0f17, i.e. black. That is how the
 * printing screen failed on an iPad (iPadOS 15.7): a black rectangle carrying
 * no information, on a device with no devtools attached.
 *
 * So the boundary is deliberately dumb: plain inline styles, no Tailwind class
 * (the stylesheet may itself be the thing that failed), no hooks. It has to be
 * able to render on a browser where everything else did not.
 */
type Props = { children: ReactNode };
type State = { error: Error | null };

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Same sink the inline reporter in index.html uses, so a crash on a
    // wall-mounted TV or a tablet still lands in the bridge log.
    try {
      fetch(`${BRIDGE_HTTP}/client-log`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: 'react',
          stage: 'render',
          message: `${error.name}: ${error.message}\n${(info.componentStack || '').slice(0, 600)}`,
          ua: navigator.userAgent,
        }),
      }).catch(() => {});
    } catch {
      /* diagnostics must never become their own failure */
    }
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div
        style={{
          minHeight: '100%',
          background: '#fff',
          color: '#0a0a0a',
          padding: '24px',
          font: '15px/1.5 -apple-system, system-ui, sans-serif',
          WebkitOverflowScrolling: 'touch',
          overflow: 'auto',
        }}
      >
        <div style={{ fontWeight: 800, fontSize: '20px', marginBottom: '8px' }}>This screen crashed</div>
        <div style={{ color: '#737373', marginBottom: '16px' }}>
          Show this text to whoever maintains the gate — it names the cause.
        </div>
        <pre
          style={{
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            background: '#f5f5f5',
            border: '1px solid #e5e5e5',
            borderRadius: '12px',
            padding: '12px',
            margin: 0,
          }}
        >
          {error.name}: {error.message}
          {'\n\n'}
          {navigator.userAgent}
        </pre>
        <button
          onClick={() => window.location.reload()}
          style={{
            marginTop: '16px',
            minHeight: '48px',
            padding: '0 24px',
            borderRadius: '12px',
            border: '1px solid #008A9C',
            background: '#00BCD4',
            color: '#fff',
            fontWeight: 800,
            fontSize: '16px',
          }}
        >
          Reload
        </button>
      </div>
    );
  }
}
