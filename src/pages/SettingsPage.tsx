import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  RefreshCw,
  Save,
  Server,
} from 'lucide-react';
import { api } from '../lib/api';
import type { AppSettings, HealthStatus, SettingsResponse } from '../types';

export function SettingsPage() {
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [settingsData, setSettingsData] = useState<SettingsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function loadAll() {
    setLoading(true);
    setError(null);
    try {
      const [h, s] = await Promise.all([api.getHealth(), api.getSettings()]);
      setHealth(h);
      setSettingsData(s);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load diagnostics and settings.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadAll();
  }, []);

  async function handleSaveSettings() {
    if (!settingsData) return;
    setSaving(true);
    setNotice(null);
    setError(null);
    try {
      const res = await api.updateSettings(settingsData.settings);
      setSettingsData({ ...settingsData, settings: res.settings });
      setNotice('Render and media preferences saved.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save preferences.');
    } finally {
      setSaving(false);
    }
  }

  function updateField<K extends keyof AppSettings>(key: K, value: AppSettings[K]) {
    if (!settingsData) return;
    setSettingsData({
      ...settingsData,
      settings: {
        ...settingsData.settings,
        [key]: value,
      },
    });
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight text-white [text-wrap:balance]">
            System Diagnostics & Settings
          </h1>
          <p className="mt-1 text-sm text-zinc-400">
            Verify runtime FFmpeg availability, server environment secrets, and MP4 rendering preferences.
          </p>
        </div>

        <button
          type="button"
          onClick={() => void loadAll()}
          className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-medium text-zinc-200 bg-[#141720] border border-white/10 rounded-lg hover:bg-[#1C202D] whitespace-nowrap shrink-0 cursor-pointer"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          Re-run Diagnostics
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2.5 p-4 rounded-lg bg-red-950/40 border border-red-500/30 text-xs text-red-200">
          <AlertTriangle className="w-4 h-4 text-red-400 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {notice && (
        <div className="flex items-center gap-2.5 p-4 rounded-lg bg-emerald-950/40 border border-emerald-500/30 text-xs text-emerald-200">
          <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
          <span>{notice}</span>
        </div>
      )}

      {/* Live Health Diagnostic Panel */}
      <section className="p-6 rounded-xl bg-[#12141B] border border-white/[0.08] space-y-5">
        <div className="flex items-center justify-between gap-4 pb-4 border-b border-white/[0.06]">
          <div className="flex items-center gap-2.5">
            <Server className="w-4 h-4 text-rose-400" />
            <h2 className="text-base font-semibold text-white">Runtime Health Check</h2>
          </div>
          <span className="font-mono text-xs text-zinc-500">GET /api/health</span>
        </div>

        {health && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 text-xs">
            <div className="space-y-3">
              <div>
                <p className="text-zinc-400">Backend Runtime</p>
                <p className="mt-1 font-mono text-white">
                  {health.backend.status.toUpperCase()} · Node {health.backend.nodeVersion} · Uptime{' '}
                  {health.backend.uptimeSeconds}s
                </p>
              </div>
              <div>
                <p className="text-zinc-400">Database Connection</p>
                <p className="mt-1 font-medium text-white">
                  {health.database.provider} ({health.database.status})
                </p>
                <p className="mt-0.5 text-zinc-500">{health.database.note}</p>
              </div>
              <div>
                <p className="text-zinc-400">Object Storage</p>
                <p className="mt-1 font-medium text-white">
                  {health.storage.provider} ({health.storage.status})
                </p>
                <p className="mt-0.5 text-zinc-500">{health.storage.note}</p>
              </div>
            </div>

            <div className="space-y-3">
              <div>
                <p className="text-zinc-400">FFmpeg Executable</p>
                {health.ffmpeg.available ? (
                  <>
                    <p className="mt-1 font-mono text-emerald-400">
                      Available at {health.ffmpeg.path}
                    </p>
                    <p className="mt-0.5 font-mono text-zinc-300">
                      Version: {health.ffmpeg.version}
                    </p>
                    {health.ffmpeg.codecs && health.ffmpeg.codecs.length > 0 && (
                      <p className="mt-0.5 font-mono text-zinc-500">
                        Codecs: {health.ffmpeg.codecs.join(', ')}
                      </p>
                    )}
                  </>
                ) : (
                  <p className="mt-1 font-mono text-red-400">
                    Unavailable: {health.ffmpeg.error}
                  </p>
                )}
              </div>

              <div>
                <p className="text-zinc-400">Gemini Server Integration</p>
                <p className={`mt-1 font-mono ${health.gemini.configured ? 'text-emerald-400' : 'text-amber-400'}`}>
                  {health.gemini.configured
                    ? `Configured (${health.gemini.model} + TTS)`
                    : 'Missing GEMINI_API_KEY'}
                </p>
              </div>
            </div>
          </div>
        )}
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Render & Output Preferences */}
        {settingsData && (
          <section className="p-6 rounded-xl bg-[#12141B] border border-white/[0.08] space-y-5">
            <div className="pb-4 border-b border-white/[0.06]">
              <h2 className="text-base font-semibold text-white">Video Output Preferences</h2>
              <p className="text-xs text-zinc-400">
                Applied during FFmpeg subtitle burn-in and MP4 encoding.
              </p>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1.5">
                  Default Visual Strategy
                </label>
                <select
                  value={settingsData.settings.preferredVisualProvider}
                  onChange={(e) =>
                    updateField(
                      'preferredVisualProvider',
                      e.target.value as AppSettings['preferredVisualProvider']
                    )
                  }
                  className="w-full px-3 py-2 text-xs text-white bg-[#171A23] border border-white/[0.08] rounded-lg focus:outline-none focus:border-rose-500"
                >
                  <option value="stock_first">Licensed Stock Media (Pexels / Pixabay / Wikimedia)</option>
                  <option value="ai_image_first">AI Image Generation (Requires Paid Gemini Key)</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1.5">
                  Subtitle Burn-In Style
                </label>
                <select
                  value={settingsData.settings.subtitleStyle}
                  onChange={(e) =>
                    updateField(
                      'subtitleStyle',
                      e.target.value as AppSettings['subtitleStyle']
                    )
                  }
                  className="w-full px-3 py-2 text-xs text-white bg-[#171A23] border border-white/[0.08] rounded-lg focus:outline-none focus:border-rose-500"
                >
                  <option value="bold_centered">Bold Centered Shorts Captions</option>
                  <option value="minimal_bottom">Clean Lower-Third Subtitles</option>
                </select>
              </div>

              <div className="grid grid-cols-2 gap-4 text-xs">
                <div className="p-3 rounded-lg bg-[#171A23] border border-white/[0.06]">
                  <span className="text-zinc-400">Target Resolution</span>
                  <p className="mt-1 font-mono text-white">1080 × 1920 (9:16)</p>
                </div>
                <div className="p-3 rounded-lg bg-[#171A23] border border-white/[0.06]">
                  <span className="text-zinc-400">Encoding Profile</span>
                  <p className="mt-1 font-mono text-white">30 FPS · H.264 / AAC</p>
                </div>
              </div>
            </div>

            <div className="flex justify-end pt-2">
              <button
                type="button"
                disabled={saving}
                onClick={() => void handleSaveSettings()}
                className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-rose-600 rounded-lg hover:bg-rose-500 disabled:opacity-50 cursor-pointer"
              >
                {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                Save Preferences
              </button>
            </div>
          </section>
        )}

        {/* Server Environment & Billing Transparency */}
        {settingsData && (
          <section className="p-6 rounded-xl bg-[#12141B] border border-white/[0.08] space-y-4">
            <div className="pb-4 border-b border-white/[0.06]">
              <h2 className="text-base font-semibold text-white">Server Secrets & Cloud Integrations</h2>
              <p className="text-xs text-zinc-400">
                API keys are managed strictly via server environment variables or Google Cloud Secret Manager.
              </p>
            </div>

            <div className="divide-y divide-white/[0.06] text-xs">
              <div className="py-2.5 flex items-center justify-between gap-4">
                <div>
                  <p className="font-mono text-zinc-200">GEMINI_API_KEY</p>
                  <p className="text-zinc-500">
                    Text & TTS work on free tier; Imagen/AI image generation requires paid billing.
                  </p>
                </div>
                <span className={settingsData.integrations.hasGeminiKey ? 'text-emerald-400 font-medium' : 'text-amber-400 font-medium'}>
                  {settingsData.integrations.hasGeminiKey ? 'Configured' : 'Missing'}
                </span>
              </div>

              <div className="py-2.5 flex items-center justify-between gap-4">
                <div>
                  <p className="font-mono text-zinc-200">Wikimedia Commons Stock</p>
                  <p className="text-zinc-500">
                    Free open-license CC / Public Domain imagery (zero API key required).
                  </p>
                </div>
                <span className="text-emerald-400 font-medium">Available</span>
              </div>

              <div className="py-2.5 flex items-center justify-between gap-4">
                <div>
                  <p className="font-mono text-zinc-200">PEXELS_API_KEY / PIXABAY_API_KEY</p>
                  <p className="text-zinc-500">
                    Optional free-tier stock HD vertical video & photography keys.
                  </p>
                </div>
                <span className={settingsData.integrations.hasPexelsKey || settingsData.integrations.hasPixabayKey ? 'text-emerald-400 font-medium' : 'text-zinc-400'}>
                  {settingsData.integrations.hasPexelsKey || settingsData.integrations.hasPixabayKey ? 'Configured' : 'Optional'}
                </span>
              </div>

              <div className="py-2.5 flex items-center justify-between gap-4">
                <div>
                  <p className="font-mono text-zinc-200">GCS_BUCKET_NAME</p>
                  <p className="text-zinc-500">
                    {health?.storage.note || 'Google Cloud Storage bucket for permanent MP4 storage.'}
                  </p>
                </div>
                <span
                  className={
                    health?.storage.status === 'connected'
                      ? 'text-emerald-400 font-medium whitespace-nowrap'
                      : settingsData.integrations.hasGcsBucket
                        ? 'text-amber-400 font-medium whitespace-nowrap'
                        : 'text-zinc-400 whitespace-nowrap'
                  }
                >
                  {health?.storage.status === 'connected'
                    ? 'Connected'
                    : settingsData.integrations.hasGcsBucket
                      ? 'Inaccessible'
                      : 'Unconfigured'}
                </span>
              </div>

              <div className="py-2.5 flex items-center justify-between gap-4">
                <div>
                  <p className="font-mono text-zinc-200">SCHEDULER_SECRET</p>
                  <p className="text-zinc-500">
                    Server-only secret protecting Cloud Scheduler POST /api/automation/trigger requests.
                  </p>
                </div>
                <span className={settingsData.integrations.hasSchedulerSecret ? 'text-emerald-400 font-medium' : 'text-amber-400 font-medium'}>
                  {settingsData.integrations.hasSchedulerSecret ? 'Configured (Server Only)' : 'Unconfigured (503)'}
                </span>
              </div>

              <div className="py-2.5 flex items-center justify-between gap-4">
                <div>
                  <p className="font-mono text-zinc-200">Firebase Authentication & Per-User Isolation</p>
                  <p className="text-zinc-500">
                    All private endpoints require verified Firebase sessions and enforce owner UID isolation.
                  </p>
                </div>
                <span className="text-emerald-400 font-medium">
                  {settingsData.integrations.firestoreConfigured ? 'Enforced' : 'Active'}
                </span>
              </div>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
