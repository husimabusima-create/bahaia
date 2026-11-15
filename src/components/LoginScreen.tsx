import { AlertTriangle, Clapperboard, Loader2, Lock, ShieldCheck } from 'lucide-react';
import { useAuth } from '../context/AuthContext';

export function LoginScreen() {
  const { signInWithGoogle, signingIn, authError, user, signOutUser } = useAuth();

  return (
    <div className="min-h-screen bg-[#0B0C10] text-[#F4F5F7] flex flex-col justify-center items-center px-4 py-12">
      <div className="w-full max-w-md rounded-2xl bg-[#12141B] border border-white/[0.08] p-8 shadow-2xl space-y-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-lg bg-rose-600/15 border border-rose-500/30 flex items-center justify-center">
              <Clapperboard className="w-5 h-5 text-rose-500" />
            </div>
            <div>
              <span className="font-display text-xl font-bold tracking-tight text-white">
                Short<span className="text-rose-500">Forge</span>
              </span>
              <p className="text-[11px] font-mono text-zinc-500">Vertical 9:16 Studio</p>
            </div>
          </div>
          <span className="inline-flex items-center gap-1.5 text-[11px] font-mono text-zinc-400 px-2.5 py-1 rounded-md bg-[#0B0C10] border border-white/[0.08]">
            <Lock className="w-3 h-3 text-rose-400" />
            Protected
          </span>
        </div>

        <div className="space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight text-white">
            Sign in to continue
          </h1>
          <p className="text-sm text-zinc-400 leading-relaxed">
            Access your private video production workspace, rendered 1080×1920 MP4 library, and daily automation settings.
          </p>
        </div>

        {authError && (
          <div
            role="alert"
            className="flex items-start gap-2.5 p-3.5 rounded-lg bg-red-950/40 border border-red-500/30 text-xs text-red-200"
          >
            <AlertTriangle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
            <span>{authError}</span>
          </div>
        )}

        <div className="space-y-3">
          <button
            type="button"
            disabled={signingIn}
            onClick={() => void signInWithGoogle()}
            className="w-full inline-flex items-center justify-center gap-2.5 px-4 py-3 text-sm font-semibold text-white bg-rose-600 rounded-lg hover:bg-rose-500 disabled:opacity-60 transition-colors cursor-pointer"
          >
            {signingIn ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Signing in with Google...
              </>
            ) : (
              <>
                <ShieldCheck className="w-4 h-4" />
                Sign in with Google
              </>
            )}
          </button>

          {user && (
            <button
              type="button"
              onClick={() => void signOutUser()}
              className="w-full px-4 py-2 text-xs font-medium text-zinc-300 bg-[#181B24] border border-white/10 rounded-lg hover:bg-[#222736] transition-colors cursor-pointer"
            >
              Switch Google Account ({user.email})
            </button>
          )}
        </div>

        <div className="pt-4 border-t border-white/[0.06] space-y-2 text-xs text-zinc-500">
          <div className="flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
            <span>User-isolated video jobs, scripts, and MP4 downloads</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
            <span>Server-side API keys and rate-limited rendering</span>
          </div>
        </div>
      </div>
    </div>
  );
}
