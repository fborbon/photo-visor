import React from 'react';
import ReactDOM from 'react-dom/client';
import { Amplify } from 'aws-amplify';
import config from './config';
import App from './App';
import './index.css';
import 'leaflet/dist/leaflet.css';

Amplify.configure({
  Auth: {
    Cognito: {
      userPoolId:       config.userPoolId,
      userPoolClientId: config.userPoolClientId,
      identityPoolId:   config.identityPoolId,
    },
  },
});

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state = { error: null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    const { error } = this.state;
    if (error) {
      return (
        <div style={{ padding: 32, fontFamily: 'monospace', color: '#ff4444', background: '#111', minHeight: '100vh' }}>
          <h2>App error</h2>
          <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
            {(error as Error).message}{'\n\n'}{(error as Error).stack}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}

const root = document.getElementById('root');
if (!root) throw new Error('No #root element');

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
