import { type FormEvent, useEffect, useState, useSyncExternalStore } from 'react';
import axios from 'axios';

import { apiClient } from './api/client';
import { session } from './auth/session';
import { config } from './config';

type Activity = {
  kind: 'idle' | 'working' | 'success' | 'error';
  message: string;
};

const initialActivity: Activity = {
  kind: 'idle',
  message: 'Configure your own API, then sign in to inspect the DPoP flow.'
};

const getErrorMessage = (error: unknown) => {
  if (axios.isAxiosError(error)) {
    return `${error.response?.status || 'Network error'}: ${error.message}`;
  }
  return error instanceof Error ? error.message : 'Unknown error';
};

export default function App() {
  const auth = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const [username, setUsername] = useState('demo.user');
  const [password, setPassword] = useState('');
  const [activity, setActivity] = useState<Activity>(initialActivity);
  const [profile, setProfile] = useState<unknown>(null);

  useEffect(() => {
    session.restore().catch((error) => {
      setActivity({ kind: 'error', message: `Session restore failed: ${getErrorMessage(error)}` });
    });
  }, []);

  const signIn = async (event: FormEvent) => {
    event.preventDefault();
    setActivity({ kind: 'working', message: 'Creating a P-256 key and signing the login proof…' });
    try {
      await session.login({ username, password });
      setPassword('');
      setActivity({ kind: 'success', message: 'DPoP session created and saved in IndexedDB.' });
    } catch (error) {
      setActivity({ kind: 'error', message: getErrorMessage(error) });
    }
  };

  const loadProfile = async () => {
    setActivity({ kind: 'working', message: 'Calling the protected resource with a fresh proof…' });
    try {
      const response = await apiClient.get(config.profilePath);
      setProfile(response.data);
      setActivity({ kind: 'success', message: 'Protected request completed.' });
    } catch (error) {
      setActivity({ kind: 'error', message: getErrorMessage(error) });
    }
  };

  const refresh = async () => {
    setActivity({ kind: 'working', message: 'Refreshing tokens with a proof-only request…' });
    try {
      await session.refresh();
      setActivity({ kind: 'success', message: 'Access token refreshed and session rotated.' });
    } catch (error) {
      setActivity({ kind: 'error', message: getErrorMessage(error) });
    }
  };

  const logout = async () => {
    await session.logout();
    setProfile(null);
    setActivity({ kind: 'idle', message: 'Local DPoP key and token session removed.' });
  };

  return (
    <main className="shell">
      <header className="hero">
        <div className="eyebrow">React + Axios + Web Crypto</div>
        <h1>DPoP authentication, stripped to the main flow.</h1>
        <p>
          A portable frontend example showing proof creation, key-bound access tokens, one shared
          refresh request, and automatic retry after a 401 response.
        </p>
      </header>

      <section className="flow" aria-label="Authentication flow">
        <div><span>01</span>Create P-256 key</div>
        <div><span>02</span>Sign every request</div>
        <div><span>03</span>Refresh on 401</div>
        <div><span>04</span>Retry with new proof</div>
      </section>

      <div className="content-grid">
        <section className="card">
          <div className="card-heading">
            <div>
              <div className="eyebrow">Interactive client</div>
              <h2>{auth.authenticated ? 'Active session' : 'Sign in'}</h2>
            </div>
            <span className={`status-dot ${auth.authenticated ? 'online' : ''}`}>
              {auth.authenticated ? 'bound' : 'offline'}
            </span>
          </div>

          {!auth.authenticated ? (
            <form onSubmit={signIn}>
              <label>
                Username
                <input value={username} onChange={(event) => setUsername(event.target.value)} required />
              </label>
              <label>
                Password
                <input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="current-password"
                  required
                />
              </label>
              <button type="submit" disabled={activity.kind === 'working'}>Create DPoP session</button>
            </form>
          ) : (
            <div className="session-panel">
              <dl>
                <div>
                  <dt>Key thumbprint</dt>
                  <dd>{auth.jkt}</dd>
                </div>
                <div>
                  <dt>Access token expires</dt>
                  <dd>{auth.expiresAt ? new Date(auth.expiresAt).toLocaleString() : 'Unknown'}</dd>
                </div>
              </dl>
              <div className="button-row">
                <button onClick={loadProfile}>Call protected API</button>
                <button className="secondary" onClick={refresh}>Refresh now</button>
                <button className="ghost" onClick={logout}>Clear session</button>
              </div>
            </div>
          )}

          <div className={`activity ${activity.kind}`}>{activity.message}</div>
          {profile !== null && <pre>{JSON.stringify(profile, null, 2)}</pre>}
        </section>

        <aside className="card contract-card">
          <div className="eyebrow">Example API contract</div>
          <h2>Replace only the adapter points.</h2>
          <div className="endpoint">
            <span>Base URL</span>
            <code>{config.apiBaseUrl}</code>
          </div>
          <div className="endpoint">
            <span>Login</span>
            <code>POST {config.loginPath}</code>
          </div>
          <div className="endpoint">
            <span>Refresh</span>
            <code>POST {config.refreshPath}</code>
          </div>
          <div className="endpoint">
            <span>Protected resource</span>
            <code>GET {config.profilePath}</code>
          </div>
          <p className="note">
            The sample host uses the reserved <code>.invalid</code> domain. Set your own values in
            <code>.env.local</code> before testing.
          </p>
        </aside>
      </div>

      <footer>
        This demo never renders or logs access and refresh tokens. The private key is non-extractable
        and persisted by the browser in IndexedDB.
      </footer>
    </main>
  );
}
