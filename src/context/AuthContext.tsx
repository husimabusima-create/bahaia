import {
  onAuthStateChanged,
  signInWithPopup,
  signOut,
  type User,
} from 'firebase/auth';
import { doc, getDoc, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import { api, ApiClientError } from '../lib/api';
import {
  auth,
  db,
  googleProvider,
  handleFirestoreError,
  OperationType,
} from '../lib/firebase';

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  sessionReady: boolean;
  signingIn: boolean;
  authError: string | null;
  signInWithGoogle: () => Promise<void>;
  signOutUser: () => Promise<void>;
  clearAuthError: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

async function syncUserProfileDocument(user: User): Promise<void> {
  if (!user.email) return;
  const userPath = `users/${user.uid}`;
  const userRef = doc(db, 'users', user.uid);
  const displayName = user.displayName ? user.displayName.slice(0, 120) : undefined;
  const photoURL = user.photoURL ? user.photoURL.slice(0, 512) : undefined;

  let existingSnap;
  try {
    existingSnap = await getDoc(userRef);
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, userPath);
  }

  if (!existingSnap.exists()) {
    try {
      await setDoc(userRef, {
        uid: user.uid,
        email: user.email.slice(0, 254),
        ...(displayName ? { displayName } : {}),
        ...(photoURL ? { photoURL } : {}),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, userPath);
    }
  } else {
    try {
      await updateDoc(userRef, {
        email: user.email.slice(0, 254),
        ...(displayName ? { displayName } : {}),
        ...(photoURL ? { photoURL } : {}),
        updatedAt: serverTimestamp(),
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, userPath);
    }
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [sessionReady, setSessionReady] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    const unsubscribe = onAuthStateChanged(auth, async (nextUser) => {
      if (!active) return;

      if (!nextUser) {
        setUser(null);
        setSessionReady(false);
        setLoading(false);
        return;
      }

      setSessionReady(false);
      setUser(nextUser);

      try {
        const idToken = await nextUser.getIdToken();
        try {
          await api.createSession(idToken);
        } catch (sessionErr) {
          if (
            sessionErr instanceof ApiClientError &&
            (sessionErr.status === 401 || sessionErr.status === 403)
          ) {
            throw sessionErr;
          }
          // Transient retry or verify Bearer auth directly if cookie storage is restricted
          await new Promise((resolve) => setTimeout(resolve, 600));
          try {
            await api.createSession(idToken);
          } catch (retryErr) {
            if (
              retryErr instanceof ApiClientError &&
              (retryErr.status === 401 || retryErr.status === 403)
            ) {
              throw retryErr;
            }
            await api.getMe();
          }
        }

        if (!active) return;

        // Best-effort Firestore profile sync aligned with firestore.rules
        void syncUserProfileDocument(nextUser).catch(() => undefined);

        setSessionReady(true);
        setAuthError(null);
      } catch (err) {
        if (!active) return;
        setSessionReady(false);
        setAuthError(
          err instanceof Error
            ? err.message
            : 'Unable to establish an authenticated server session.'
        );
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  // Periodically refresh the HttpOnly media/download session cookie before 55m expiry
  useEffect(() => {
    if (!user || !sessionReady) return;
    const timer = window.setInterval(async () => {
      try {
        const freshToken = await user.getIdToken(true);
        await api.createSession(freshToken);
      } catch {
        // Handled on next API call
      }
    }, 40 * 60 * 1000);

    return () => window.clearInterval(timer);
  }, [user, sessionReady]);

  const signInWithGoogle = useCallback(async () => {
    setSigningIn(true);
    setAuthError(null);
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err) {
      const code =
        err && typeof err === 'object' && 'code' in err
          ? String((err as { code?: unknown }).code)
          : '';
      if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
        setAuthError('Sign-in popup was closed before completing authentication.');
      } else if (code === 'auth/popup-blocked') {
        setAuthError(
          'Browser blocked the Google sign-in popup. Allow popups for this preview window and try again.'
        );
      } else if (code === 'auth/unauthorized-domain') {
        setAuthError(
          `This domain (${window.location.hostname}) is not authorized in Firebase Authentication > Settings > Authorized domains.`
        );
      } else if (code === 'auth/network-request-failed') {
        setAuthError('Network error while contacting Google Authentication. Check connection and retry.');
      } else {
        setAuthError(err instanceof Error ? err.message : 'Google sign-in failed.');
      }
    } finally {
      setSigningIn(false);
    }
  }, []);

  const signOutUser = useCallback(async () => {
    setAuthError(null);
    try {
      await api.clearSession().catch(() => undefined);
      await signOut(auth);
      setSessionReady(false);
      setUser(null);
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'Failed to sign out.');
    }
  }, []);

  const clearAuthError = useCallback(() => setAuthError(null), []);

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        sessionReady,
        signingIn,
        authError,
        signInWithGoogle,
        signOutUser,
        clearAuthError,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used inside AuthProvider');
  }
  return ctx;
}
