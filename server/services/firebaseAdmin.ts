import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getApps, initializeApp, type App } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';

export interface FirebaseAppletConfig {
  projectId: string;
  appId: string;
  apiKey: string;
  authDomain: string;
  firestoreDatabaseId: string;
  storageBucket?: string;
}

export interface AuthenticatedUser {
  uid: string;
  email: string;
  emailVerified: boolean;
  displayName?: string;
  idToken?: string;
}

interface SessionPayload {
  uid: string;
  email: string;
  emailVerified: boolean;
  displayName?: string;
  iat: number;
  exp: number;
}

export const SESSION_COOKIE_NAME = 'sf_session';
const SESSION_TTL_MS = 55 * 60 * 1000; // 55 minutes (aligned with Firebase 1h token lifecycle)

let cachedConfig: FirebaseAppletConfig | null = null;
let cachedApp: App | null = null;
let cachedDb: Firestore | null = null;
let runtimeSessionSecret: string | null = null;

export function getFirebaseConfig(): FirebaseAppletConfig {
  if (!cachedConfig) {
    const configPath = path.resolve(process.cwd(), 'firebase-applet-config.json');
    const raw = fs.readFileSync(configPath, 'utf8');
    cachedConfig = JSON.parse(raw) as FirebaseAppletConfig;
  }
  return cachedConfig;
}

function getSessionSigningSecret(): Buffer {
  if (!runtimeSessionSecret) {
    const configured =
      process.env.SESSION_SECRET?.trim() || process.env.SCHEDULER_SECRET?.trim();
    if (configured && configured.length >= 16) {
      runtimeSessionSecret = crypto
        .createHash('sha256')
        .update(`shortforge-session-v1:${configured}`)
        .digest('hex');
    } else {
      runtimeSessionSecret = crypto.randomBytes(32).toString('hex');
    }
  }
  return Buffer.from(runtimeSessionSecret, 'utf8');
}

export function getFirebaseAdminApp(): App {
  if (!cachedApp) {
    const existing = getApps();
    if (existing.length > 0) {
      cachedApp = existing[0]!;
    } else {
      const cfg = getFirebaseConfig();
      cachedApp = initializeApp({
        projectId: cfg.projectId,
      });
    }
  }
  return cachedApp;
}

export function getAdminFirestore(): Firestore {
  if (!cachedDb) {
    const app = getFirebaseAdminApp();
    const cfg = getFirebaseConfig();
    cachedDb = getFirestore(app, cfg.firestoreDatabaseId);
  }
  return cachedDb;
}

export async function verifyFirebaseIdToken(idToken: string): Promise<AuthenticatedUser> {
  const app = getFirebaseAdminApp();
  const decoded = await getAuth(app).verifyIdToken(idToken);
  const email = typeof decoded.email === 'string' ? decoded.email : '';
  const emailVerified = Boolean(decoded.email_verified);
  if (!decoded.uid) {
    throw new Error('Firebase token missing UID.');
  }
  return {
    uid: decoded.uid,
    email,
    emailVerified,
    displayName: typeof decoded.name === 'string' ? decoded.name : undefined,
    idToken,
  };
}

export function createSignedSessionToken(user: AuthenticatedUser): string {
  const now = Date.now();
  const payload: SessionPayload = {
    uid: user.uid,
    email: user.email,
    emailVerified: user.emailVerified,
    ...(user.displayName ? { displayName: user.displayName } : {}),
    iat: now,
    exp: now + SESSION_TTL_MS,
  };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto
    .createHmac('sha256', getSessionSigningSecret())
    .update(encoded)
    .digest('base64url');
  return `${encoded}.${sig}`;
}

export function verifySignedSessionToken(cookieValue: string): AuthenticatedUser | null {
  if (!cookieValue || typeof cookieValue !== 'string') return null;
  const dotIdx = cookieValue.indexOf('.');
  if (dotIdx <= 0) return null;

  const encoded = cookieValue.slice(0, dotIdx);
  const providedSig = cookieValue.slice(dotIdx + 1);
  if (!encoded || !providedSig) return null;

  const expectedSig = crypto
    .createHmac('sha256', getSessionSigningSecret())
    .update(encoded)
    .digest('base64url');

  const a = Buffer.from(providedSig, 'utf8');
  const b = Buffer.from(expectedSig, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return null;
  }

  try {
    const decoded = JSON.parse(
      Buffer.from(encoded, 'base64url').toString('utf8')
    ) as SessionPayload;
    if (!decoded.uid || !decoded.exp || Date.now() > decoded.exp) {
      return null;
    }
    return {
      uid: decoded.uid,
      email: decoded.email || '',
      emailVerified: Boolean(decoded.emailVerified),
      displayName: decoded.displayName,
    };
  } catch {
    return null;
  }
}
