import axios from 'axios';

import { config, toApiUrl } from '../config';
import { dpopProofService, type StoredDpopSession } from '../security/DpopProofService';

type Credentials = {
  username: string;
  password: string;
};

type TokenResponse = {
  accessToken: string;
  refreshToken?: string;
};

type AuthTokens = Required<TokenResponse>;

export type SessionSnapshot = {
  authenticated: boolean;
  expiresAt?: number;
  jkt?: string;
};

let currentSession: StoredDpopSession | null = null;
let refreshPromise: Promise<string> | null = null;
let sessionGeneration = 0;
const listeners = new Set<() => void>();
let snapshot: SessionSnapshot = { authenticated: false };

const emitChange = () => {
  snapshot = {
    authenticated: Boolean(currentSession?.accessToken),
    expiresAt: currentSession?.expiresAt,
    jkt: currentSession?.jkt
  };
  listeners.forEach((listener) => listener());
};

const normalizeTokenResponse = (value: TokenResponse, fallbackRefreshToken?: string): AuthTokens => {
  const refreshToken = value?.refreshToken || fallbackRefreshToken;
  if (!value?.accessToken || !refreshToken) {
    throw new Error('The token response must contain accessToken and refreshToken.');
  }
  return { accessToken: value.accessToken, refreshToken };
};

const commitTokens = async (tokens: AuthTokens): Promise<string> => {
  currentSession = await dpopProofService.persistSession(tokens.accessToken, tokens.refreshToken);
  emitChange();
  return tokens.accessToken;
};

export const session = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  getSnapshot(): SessionSnapshot {
    return snapshot;
  },

  getAccessToken(): string | null {
    return currentSession?.accessToken || null;
  },

  async login(credentials: Credentials): Promise<void> {
    const loginGeneration = ++sessionGeneration;
    currentSession = null;
    emitChange();
    await dpopProofService.prepareForLogin();
    const loginUrl = toApiUrl(config.loginPath);
    const proof = await dpopProofService.createProof('POST', loginUrl);
    const response = await axios.post<TokenResponse>(loginUrl, credentials, {
      headers: { DPoP: proof }
    });
    if (loginGeneration !== sessionGeneration) {
      throw new Error('The login session changed before the request completed.');
    }
    await commitTokens(normalizeTokenResponse(response.data));
  },

  async restore(): Promise<void> {
    const restoreGeneration = sessionGeneration;
    const restoredSession = await dpopProofService.restoreSession();
    if (restoreGeneration !== sessionGeneration) return;

    currentSession = restoredSession;
    emitChange();

    if (currentSession && currentSession.expiresAt <= Date.now()) {
      await this.refresh();
    }
  },

  async refresh(): Promise<string> {
    if (refreshPromise) return refreshPromise;
    if (!currentSession?.refreshToken) throw new Error('No refresh token is available.');

    const refreshToken = currentSession.refreshToken;
    const refreshGeneration = sessionGeneration;
    const refreshUrl = toApiUrl(config.refreshPath);
    refreshPromise = (async () => {
      const proof = await dpopProofService.createProof('POST', refreshUrl);
      const response = await axios.post<TokenResponse>(
        refreshUrl,
        { refreshToken },
        { headers: { DPoP: proof } }
      );
      const tokens = normalizeTokenResponse(response.data, refreshToken);
      if (refreshGeneration !== sessionGeneration) {
        throw new Error('The session changed before refresh completed.');
      }
      return commitTokens(tokens);
    })();

    try {
      return await refreshPromise;
    } catch (error) {
      await this.logout();
      throw error;
    } finally {
      refreshPromise = null;
    }
  },

  async logout(): Promise<void> {
    sessionGeneration += 1;
    currentSession = null;
    refreshPromise = null;
    await dpopProofService.clearSession();
    emitChange();
  }
};
