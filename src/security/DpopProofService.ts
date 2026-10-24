type JsonObject = Record<string, unknown>;

type AccessTokenClaims = {
  exp?: number;
  cnf?: { jkt?: string };
};

export type StoredDpopSession = {
  version: 1;
  keyPair: CryptoKeyPair;
  publicJwk: JsonWebKey;
  jkt: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
};

const DATABASE_NAME = 'dpop-demo-session';
const DATABASE_VERSION = 1;
const STORE_NAME = 'auth';
const SESSION_KEY = 'current';
const SESSION_VERSION = 1;

let databasePromise: Promise<IDBDatabase> | undefined;

const base64UrlEncode = (bytes: Uint8Array): string => {
  let binary = '';
  bytes.forEach((value) => {
    binary += String.fromCharCode(value);
  });

  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
};

const encodeJson = (value: JsonObject): string =>
  base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));

const sha256 = async (value: string): Promise<string> =>
  base64UrlEncode(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))
  );

const decodeAccessToken = (accessToken: string): AccessTokenClaims => {
  const encodedPayload = accessToken.split('.')[1];
  if (!encodedPayload) throw new Error('The access token is not a JWT.');

  const normalized = encodedPayload.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  return JSON.parse(atob(padded)) as AccessTokenClaims;
};

export const getAccessTokenExpiresAt = (accessToken: string): number => {
  const expiresAt = decodeAccessToken(accessToken).exp;
  if (!expiresAt) throw new Error('The access token does not contain an exp claim.');
  return expiresAt * 1000;
};

const openDatabase = (): Promise<IDBDatabase> => {
  if (!databasePromise) {
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) {
          request.result.createObjectStore(STORE_NAME);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  return databasePromise;
};

const readSession = async (): Promise<StoredDpopSession | undefined> => {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = database.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(SESSION_KEY);
    request.onsuccess = () => resolve(request.result as StoredDpopSession | undefined);
    request.onerror = () => reject(request.error);
  });
};

const writeSession = async (session: StoredDpopSession): Promise<void> => {
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).put(session, SESSION_KEY);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
};

const deleteSession = async (): Promise<void> => {
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).delete(SESSION_KEY);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
};

const getKeyBinding = async (keyPair: CryptoKeyPair) => {
  const exported = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
  const publicJwk: JsonWebKey = {
    kty: 'EC',
    crv: 'P-256',
    x: exported.x,
    y: exported.y
  };
  const jkt = await sha256(
    JSON.stringify({ crv: publicJwk.crv, kty: publicJwk.kty, x: publicJwk.x, y: publicJwk.y })
  );

  return { publicJwk, jkt };
};

const verifyTokenBinding = async (keyPair: CryptoKeyPair, accessToken: string) => {
  const tokenJkt = decodeAccessToken(accessToken).cnf?.jkt;
  if (!tokenJkt) throw new Error('The access token does not contain a cnf.jkt binding.');

  const binding = await getKeyBinding(keyPair);
  if (tokenJkt !== binding.jkt) {
    throw new Error('The access token is bound to a different DPoP key.');
  }

  return binding;
};

class DpopProofService {
  private keyPair?: CryptoKeyPair;

  private ensureSecureContext(): void {
    if (!window.isSecureContext || !crypto.subtle) {
      throw new Error('DPoP requires HTTPS or localhost because it uses the Web Crypto API.');
    }
  }

  private async createKeyPair(): Promise<CryptoKeyPair> {
    this.ensureSecureContext();
    return crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign', 'verify']
    ) as Promise<CryptoKeyPair>;
  }

  async prepareForLogin(): Promise<void> {
    await this.clearSession();
    this.keyPair = await this.createKeyPair();
  }

  async persistSession(accessToken: string, refreshToken: string): Promise<StoredDpopSession> {
    if (!this.keyPair) throw new Error('Create a DPoP key before storing a session.');

    const { publicJwk, jkt } = await verifyTokenBinding(this.keyPair, accessToken);
    const session: StoredDpopSession = {
      version: SESSION_VERSION,
      keyPair: this.keyPair,
      publicJwk,
      jkt,
      accessToken,
      refreshToken,
      expiresAt: getAccessTokenExpiresAt(accessToken)
    };
    await writeSession(session);
    return session;
  }

  async restoreSession(): Promise<StoredDpopSession | null> {
    try {
      const session = await readSession();
      if (!session?.keyPair || !session.accessToken || !session.refreshToken) return null;

      const { publicJwk, jkt } = await verifyTokenBinding(session.keyPair, session.accessToken);
      const restoredSession: StoredDpopSession = {
        ...session,
        version: SESSION_VERSION,
        publicJwk,
        jkt,
        expiresAt: getAccessTokenExpiresAt(session.accessToken)
      };
      this.keyPair = session.keyPair;

      if (
        session.version !== SESSION_VERSION ||
        session.jkt !== jkt ||
        session.expiresAt !== restoredSession.expiresAt
      ) {
        await writeSession(restoredSession);
      }

      return restoredSession;
    } catch {
      await this.clearSession();
      return null;
    }
  }

  async createProof(method: string, requestUrl: string, accessToken?: string): Promise<string> {
    this.ensureSecureContext();
    if (!this.keyPair) {
      const session = await readSession();
      this.keyPair = session?.keyPair;
    }
    if (!this.keyPair) throw new Error('No DPoP signing key is available. Sign in first.');
    if (accessToken) await verifyTokenBinding(this.keyPair, accessToken);

    const target = new URL(requestUrl, window.location.origin);
    const { publicJwk } = await getKeyBinding(this.keyPair);
    const claims: JsonObject = {
      jti: crypto.randomUUID(),
      htm: method.toUpperCase(),
      htu: `${target.origin}${target.pathname}`,
      iat: Math.floor(Date.now() / 1000)
    };
    if (accessToken) claims.ath = await sha256(accessToken);

    const signingInput = `${encodeJson({ typ: 'dpop+jwt', alg: 'ES256', jwk: publicJwk })}.${encodeJson(claims)}`;
    const signature = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      this.keyPair.privateKey,
      new TextEncoder().encode(signingInput)
    );

    return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
  }

  async clearSession(): Promise<void> {
    this.keyPair = undefined;
    await deleteSession().catch(() => undefined);
  }
}

export const dpopProofService = new DpopProofService();
