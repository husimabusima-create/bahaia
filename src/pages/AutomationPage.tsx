import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  Loader2,
  Play,
  Save,
} from 'lucide-react';
import { api, ApiClientError } from '../lib/api';
import {
  CATEGORY_LABELS,
  VIDEO_CATEGORIES,
  VOICE_OPTIONS,
  type AutomationConfig,
  type AutomationRunLog,
  type VideoCategory,
  type VisualMode,
} from '../types';

export function AutomationPage() {
  const [config, setConfig] = useState<AutomationConfig | null>(null);
  const [runs, setRuns] = useState<AutomationRunLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [runningTest, setRunningTest] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function loadAutomation() {
    setLoading(true);
    setError(null);
    try {
      const data = await api.getAutomation();
      setConfig(data.config);
      setRuns(data.runs);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load automation configuration.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadAutomation();
  }, []);

  async function handleSave() {
    if (!config) return;
    setSaving(true);
    setNotice(null);
    setError(null);
    try {
      const updated = await api.updateAutomation(config);
      setConfig(updated.config);
      setRuns(updated.runs);
      setNotice('Automation schedule settings saved.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update automation config.');
    } finally {
      setSaving(false);
    }
  }

  async function handleManualTrigger() {
    setRunningTest(true);
    setNotice(null);
    setError(null);
    try {
      const res = await api.triggerAutomationManual();
      if (res.video) {
        setNotice(
          `Automated job produced verified ${res.video.output?.resolution} MP4: "${res.video.script?.title || res.video.topic}".`
        );
      } else if (res.skipped) {
        setNotice(res.reason || 'Run skipped.');
      }
      await loadAutomation();
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? err.message
          : 'Failed to execute automated video pipeline.'
      );
      await loadAutomation();
    } finally {
      setRunningTest(false);
    }
  }

  if (loading || !config) {
    return (
      <div className="space-y-4">
        <div className="h-10 w-64 bg-[#12141B] rounded-lg animate-pulse" />
        <div className="h-72 bg-[#12141B] border border-white/[0.08] rounded-xl animate-pulse" />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight text-white [text-wrap:balance]">
            Daily Automation & Cloud Scheduler
          </h1>
          <p className="mt-1 text-sm text-zinc-400">
            Automatically produce two vertical MP4 videos every day via Google Cloud Scheduler.
          </p>
        </div>

        <button
          type="button"
          disabled={runningTest}
          onClick={() => void handleManualTrigger()}
          className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-rose-600 rounded-lg hover:bg-rose-500 disabled:opacity-60 whitespace-nowrap shrink-0 cursor-pointer"
        >
          {runningTest ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Play className="w-3.5 h-3.5" />
          )}
          {runningTest ? 'Running Full Pipeline...' : 'Run Automated Video Now'}
        </button>
      </div>

      {error && (
        <div className="flex items-start gap-2.5 p-4 rounded-lg bg-red-950/40 border border-red-500/30 text-xs text-red-200">
          <AlertTriangle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {notice && (
        <div className="flex items-start gap-2.5 p-4 rounded-lg bg-emerald-950/40 border border-emerald-500/30 text-xs text-emerald-200">
          <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
          <span>{notice}</span>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Configuration Panel */}
        <section className="lg:col-span-7 p-6 rounded-xl bg-[#12141B] border border-white/[0.08] space-y-6">
          <div className="flex items-center justify-between gap-4 pb-4 border-b border-white/[0.06]">
            <div>
              <h2 className="text-base font-semibold text-white">Schedule Configuration</h2>
              <p className="text-xs text-zinc-400">
                Stateless Cloud Run architecture: triggered externally without in-process timers.
              </p>
            </div>
            <label className="inline-flex items-center gap-2.5 cursor-pointer">
              <span className="text-xs font-medium text-zinc-300">
                {config.enabled ? 'Enabled' : 'Disabled'}
              </span>
              <input
                type="checkbox"
                checked={config.enabled}
                onChange={(e) => setConfig({ ...config, enabled: e.target.checked })}
                className="w-4 h-4 accent-rose-600 rounded cursor-pointer"
              />
            </label>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-zinc-300 mb-1.5">
                Videos Per Day
              </label>
              <select
                value={config.videosPerDay}
                onChange={(e) =>
                  setConfig({ ...config, videosPerDay: Number(e.target.value) })
                }
                className="w-full px-3 py-2 text-xs text-white bg-[#171A23] border border-white/[0.08] rounded-lg focus:outline-none focus:border-rose-500"
              >
                <option value={1}>1 video / day</option>
                <option value={2}>2 videos / day (Recommended)</option>
                <option value={3}>3 videos / day</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-zinc-300 mb-1.5">
                Category Strategy
              </label>
              <select
                value={config.defaultCategory}
                onChange={(e) =>
                  setConfig({
                    ...config,
                    defaultCategory: e.target.value as VideoCategory | 'rotate',
                  })
                }
                className="w-full px-3 py-2 text-xs text-white bg-[#171A23] border border-white/[0.08] rounded-lg focus:outline-none focus:border-rose-500"
              >
                <option value="rotate">Rotate Across All Categories</option>
                {VIDEO_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {CATEGORY_LABELS[c]}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-zinc-300 mb-1.5">
                Default Duration (Seconds)
              </label>
              <select
                value={config.defaultDurationSeconds}
                onChange={(e) =>
                  setConfig({
                    ...config,
                    defaultDurationSeconds: Number(e.target.value),
                  })
                }
                className="w-full px-3 py-2 text-xs text-white bg-[#171A23] border border-white/[0.08] rounded-lg focus:outline-none focus:border-rose-500"
              >
                <option value={30}>30 seconds</option>
                <option value={45}>45 seconds</option>
                <option value={60}>60 seconds</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-zinc-300 mb-1.5">
                Default Narration Voice
              </label>
              <select
                value={config.defaultVoiceId}
                onChange={(e) =>
                  setConfig({ ...config, defaultVoiceId: e.target.value })
                }
                className="w-full px-3 py-2 text-xs text-white bg-[#171A23] border border-white/[0.08] rounded-lg focus:outline-none focus:border-rose-500"
              >
                {VOICE_OPTIONS.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-zinc-300 mb-1.5">
                Default Visual Provider
              </label>
              <select
                value={config.defaultVisualMode || 'stock_auto'}
                onChange={(e) =>
                  setConfig({ ...config, defaultVisualMode: e.target.value as VisualMode })
                }
                className="w-full px-3 py-2 text-xs text-white bg-[#171A23] border border-white/[0.08] rounded-lg focus:outline-none focus:border-rose-500"
              >
                <option value="stock_auto">Auto Stock (Pexels / Pixabay / Wikimedia)</option>
                <option value="wikimedia">Wikimedia Commons (Free Open License)</option>
                <option value="pexels">Pexels Stock</option>
                <option value="pixabay">Pixabay Stock</option>
                <option value="ai_image">Gemini AI Image (Paid Key)</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-zinc-300 mb-1.5">
                Topic Deduplication Window (Days)
              </label>
              <input
                type="number"
                min={1}
                max={365}
                value={config.preventDuplicatesWindowDays}
                onChange={(e) =>
                  setConfig({
                    ...config,
                    preventDuplicatesWindowDays: Number(e.target.value) || 30,
                  })
                }
                className="w-full px-3 py-2 text-xs font-mono tabular-nums text-white bg-[#171A23] border border-white/[0.08] rounded-lg focus:outline-none focus:border-rose-500"
              />
            </div>

            <div className="sm:col-span-2">
              <label className="block text-xs font-medium text-zinc-300 mb-1.5">
                Daily Run Times (UTC, comma separated)
              </label>
              <input
                type="text"
                value={config.scheduleTimesUtc.join(', ')}
                onChange={(e) =>
                  setConfig({
                    ...config,
                    scheduleTimesUtc: e.target.value
                      .split(',')
                      .map((t) => t.trim())
                      .filter(Boolean),
                  })
                }
                placeholder="09:00, 21:00"
                className="w-full px-3 py-2 text-xs font-mono text-white bg-[#171A23] border border-white/[0.08] rounded-lg focus:outline-none focus:border-rose-500"
              />
            </div>
          </div>

          <div className="flex justify-end pt-2">
            <button
              type="button"
              disabled={saving}
              onClick={() => void handleSave()}
              className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-[#181B24] border border-white/15 rounded-lg hover:bg-[#232836] disabled:opacity-50 cursor-pointer"
            >
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
              Save Schedule Settings
            </button>
          </div>
        </section>

        {/* Cloud Scheduler Setup Guide */}
        <section className="lg:col-span-5 p-6 rounded-xl bg-[#12141B] border border-white/[0.08] space-y-4">
          <div className="flex items-center gap-2.5">
            <CalendarClock className="w-4 h-4 text-rose-400 shrink-0" />
            <h2 className="text-base font-semibold text-white">Google Cloud Scheduler Hook</h2>
          </div>
          <p className="text-xs text-zinc-400 leading-relaxed">
            Configure two Cloud Scheduler HTTP jobs targeting your Cloud Run URL. Each slot runs the complete Topic → Script → Visuals → TTS → FFmpeg MP4 pipeline and blocks duplicate executions for the same slot. Manual runs from this page authenticate via your active user session; scheduled cron jobs require the server-only secret header below.
          </p>

          <div className="p-3.5 rounded-lg bg-[#0B0C10] border border-white/[0.08] font-mono text-[11px] text-zinc-300 space-y-1.5 overflow-x-auto">
            <p className="text-zinc-500">Scheduled Endpoint</p>
            <p className="text-white">POST /api/automation/trigger</p>
            <p className="text-zinc-500 pt-2">Required Server-to-Server Header</p>
            <p className="text-rose-300">X-Scheduler-Secret: &lt;SCHEDULER_SECRET&gt;</p>
            <p className="text-zinc-500 pt-2">Cron Schedules (UTC)</p>
            <p>0 9 * * *   (Slot: YYYY-MM-DD-am)</p>
            <p>0 21 * * *  (Slot: YYYY-MM-DD-pm)</p>
          </div>
        </section>
      </div>

      {/* Run History Table */}
      <section className="rounded-xl bg-[#12141B] border border-white/[0.08] overflow-hidden">
        <div className="px-6 py-4 border-b border-white/[0.06]">
          <h2 className="text-base font-semibold text-white">Scheduled Execution Log</h2>
          <p className="text-xs text-zinc-400">
            Idempotent slot tracking prevents duplicate daily jobs.
          </p>
        </div>

        {runs.length === 0 ? (
          <div className="px-6 py-10 text-center text-xs text-zinc-500">
            No scheduled runs recorded yet. Click "Run Automated Video Now" above to test the complete automated pipeline.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-white/[0.06] text-zinc-400">
                  <th className="py-3 px-6 font-medium">Triggered At</th>
                  <th className="py-3 px-4 font-medium">Slot Key</th>
                  <th className="py-3 px-4 font-medium">Status</th>
                  <th className="py-3 px-6 font-medium">Result</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.06]">
                {runs.map((run) => (
                  <tr key={run.id} className="hover:bg-white/[0.02]">
                    <td className="py-3 px-6 font-mono tabular-nums text-zinc-300 whitespace-nowrap">
                      {new Date(run.triggeredAt).toLocaleString()}
                    </td>
                    <td className="py-3 px-4 font-mono text-zinc-400 whitespace-nowrap">
                      {run.slotKey}
                    </td>
                    <td className="py-3 px-4 whitespace-nowrap">
                      <span
                        className={
                          run.status === 'completed'
                            ? 'text-emerald-400 font-medium'
                            : run.status === 'failed'
                              ? 'text-red-400 font-medium'
                              : run.status === 'skipped_duplicate'
                                ? 'text-amber-400 font-medium'
                                : 'text-zinc-300'
                        }
                      >
                        {run.status}
                      </span>
                    </td>
                    <td className="py-3 px-6 text-zinc-300">{run.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
