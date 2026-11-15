import type express from 'express';
import {
  SESSION_COOKIE_NAME,
  verifyFirebaseIdToken,
  verifySignedSessionToken,
  type AuthenticatedUser,
} from '../services/firebaseAdmin.ts';

declare global {
  namespace Express {
    interface Request {
      authUser?: AuthenticatedUser;
    }
  }
}

async function resolveAuthenticatedUser(req: express.Request): Promise<AuthenticatedUser | null> {
  const authHeader = req.header('authorization') || '';
  if (authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    if (!token) return null;
    return verifyFirebaseIdToken(token);
  }

  const sessionCookie = req.cookies?.[SESSION_COOKIE_NAME];
  if (typeof sessionCookie === 'string' && sessionCookie.trim()) {
    return verifySignedSessionToken(sessionCookie.trim());
  }

  return null;
}

export async function requireAuth(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
): Promise<void> {
  try {
    const user = await resolveAuthenticatedUser(req);
    if (!user) {
      res.status(401).json({
        error: {
          code: 'UNAUTHORIZED',
          message: 'Authentication required. Sign in with Google to access ShortForge.',
          retryable: false,
        },
      });
      return;
    }
    if (user.email && !user.emailVerified) {
      res.status(403).json({
        error: {
          code: 'EMAIL_NOT_VERIFIED',
          message: 'A verified email address is required.',
          retryable: false,
        },
      });
      return;
    }
    req.authUser = user;
    next();
  } catch {
    res.status(401).json({
      error: {
        code: 'INVALID_AUTH_TOKEN',
        message: 'Invalid or expired authentication credentials. Please sign in again.',
        retryable: false,
      },
    });
  }
}

export async function optionalAuth(
  req: express.Request,
  _res: express.Response,
  next: express.NextFunction
): Promise<void> {
  try {
    const user = await resolveAuthenticatedUser(req);
    if (user && (!user.email || user.emailVerified)) {
      req.authUser = user;
    }
  } catch {
    // Ignore invalid optional auth
  }
  next();
}
