import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Download,
  Film,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { api, ApiClientError } from '../lib/api';
import { downloadAuthorizedMp4 } from '../lib/media';
import {
  CATEGORY_LABELS,
  type DashboardSummary,
  type HealthStatus,
  type VideoJob,
} from '../types';
import { StatusLabel } from '../components/StatusBadge';

interface DashboardPageProps {
  onNavigateCreate: () => void;
  onOpenVideoScript: (videoId: string) => void;
  onNavigateLibrary: () => void;
  onNavigateSettings: () => void;
}

export function DashboardPage({
  onNavigateCreate,
  onOpenVideoScript,
  onNavigateLibrary,
  onNavigateSettings,
}: DashboardPageProps) {
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  async function loadData() {
    setLoading(true);
    setError(null);
    try {
      const [dash, h] = await Promise.all([api.getDashboard(), api.getHealth()]);
      setSummary(dash);
      setHealth(h);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Failed to load dashboard metrics.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadData();
  }, []);

  async function handleDelete(id: string) {
    try {
      await api.deleteVideo(id);
      setConfirmDeleteId(null);
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
    }
  }

  async function handleDownload(video: VideoJob) {
    if (!video.output?.downloadUrl) return;
    setDownloadingId(video.id);
    setError(null);
    try {
      await downloadAuthorizedMp4(video.output.downloadUrl, video.script?.title || video.topic);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to download MP4');
    } finally {
      setDownloadingId(null);
    }
  }

  const pipelineCapabilities = [
    {
      id: '1',
      label: 'Topic & Research',
      detail: 'Gemini 4 Hydrogen',
      ready: Boolean(health?.gemini.configured),
    },
    {
      id: '2',
      label: 'Script & Scene Plan',
      detail: 'Editable 9:16 timeline',
      ready: Boolean(health?.gemini.configured),
    },
    {
      id: '3',
      label: 'Visual Media',
      detail: 'Stock (Pexels / Pixabay / Wikimedia) & AI Image',
      ready: true,
    },
    {
      id: '4',
      label: 'TTS Narration',
      detail: 'Gemini 3.8 Flash Lite TTS',
      ready: Boolean(health?.gemini.configured),
    },
    {
      id: '5',
      label: 'FFmpeg MP4 Render',
      detail: '1080×1920 H.264/AAC + ASS Subtitles',
      ready: Boolean(health?.ffmpeg.available),
    },
    {
      id: '6',
      label: 'Storage & Scheduler',
      detail: health?.storage.status === 'connected' ? 'Google Cloud Storage' : 'Local Job Storage (GCS optional)',
      ready: true,
    },
  ];

  return (
    <div className="space-y-8">
      {/* Header row */}
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight text-white [text-wrap:balance]">
            Production Overview
          </h1>
          <p className="mt-1 text-sm text-zinc-400">
            End-to-end automated short-form MP4 production powered by Gemini and FFmpeg.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => void loadData()}
            className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-medium text-zinc-300 bg-[#141720] border border-white/10 rounded-lg hover:bg-[#1B1F2B] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
          <button
            type="button"
            onClick={onNavigateCreate}
            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-rose-600 rounded-lg hover:bg-rose-500 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            Create Video
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-center justify-between gap-4 p-4 rounded-lg bg-red-950/40 border border-red-500/30 text-sm text-red-200">
          <div className="flex items-center gap-2.5">
            <AlertTriangle className="w-4 h-4 text-red-400 shrink-0" />
            <span>{error}</span>
          </div>
          <button
            type="button"
            onClick={() => void loadData()}
            className="text-xs font-medium text-red-200 underline hover:text-white shrink-0 cursor-pointer"
          >
            Retry
          </button>
        </div>
      )}

      {/* Primary KPI Grid */}
      <section aria-label="Production metrics" className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {loading && !summary ? (
          Array.from({ length: 4 }).map((_, idx) => (
            <div
              key={idx}
              className="p-5 rounded-xl bg-[#12141B] border border-white/[0.08] animate-pulse h-28"
            />
          ))
        ) : (
          <>
            <div className="p-5 rounded-xl bg-[#12141B] border border-white/[0.08]">
              <p className="text-xs font-medium text-zinc-400">Total Videos Generated</p>
              <p className="mt-3 text-3xl font-semibold font-mono tabular-nums text-white">
                {summary?.totalVideos ?? 0}
              </p>
              <p className="mt-1.5 text-xs text-zinc-500 font-mono tabular-nums">
                {summary?.scriptReadyCount ?? 0} scripts ready for render
              </p>
            </div>

            <div className="p-5 rounded-xl bg-[#12141B] border border-white/[0.08]">
              <p className="text-xs font-medium text-zinc-400">Completed Videos (MP4)</p>
              <p className="mt-3 text-3xl font-semibold font-mono tabular-nums text-emerald-400">
                {summary?.completedVideos ?? 0}
              </p>
              <p className="mt-1.5 text-xs text-zinc-500">
                Verified 1080×1920 exports
              </p>
            </div>

            <div className="p-5 rounded-xl bg-[#12141B] border border-white/[0.08]">
              <p className="text-xs font-medium text-zinc-400">Currently Processing</p>
              <p className="mt-3 text-3xl font-semibold font-mono tabular-nums text-rose-400">
                {summary?.processingJobs ?? 0}
              </p>
              <p className="mt-1.5 text-xs text-zinc-500">
                Active render pipeline jobs
              </p>
            </div>

            <div className="p-5 rounded-xl bg-[#12141B] border border-white/[0.08]">
              <p className="text-xs font-medium text-zinc-400">Failed Jobs</p>
              <p className="mt-3 text-3xl font-semibold font-mono tabular-nums text-zinc-200">
                {summary?.failedJobs ?? 0}
              </p>
              <p className="mt-1.5 text-xs text-zinc-500">
                Errors logged with retry support
              </p>
            </div>
          </>
        )}
      </section>

      {/* Pipeline Status & Infrastructure Health */}
      <section className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 p-6 rounded-xl bg-[#12141B] border border-white/[0.08]">
          <div className="flex items-center justify-between gap-4 pb-4 border-b border-white/[0.06]">
            <div>
              <h2 className="text-base font-semibold text-white">Production Pipeline</h2>
              <p className="mt-0.5 text-xs text-zinc-400">
                Topic → Research → Script → Scene Plan → Visuals → Narration → Subtitles → FFmpeg MP4
              </p>
            </div>
          </div>

          <div className="mt-4 divide-y divide-white/[0.06]">
            {pipelineCapabilities.map((item) => (
              <div key={item.id} className="py-3 flex items-center justify-between gap-4">
                <div className="flex items-center gap-3 min-w-0">
                  <span className="font-mono text-xs tabular-nums text-zinc-500 w-6">
                    0{item.id}
                  </span>
                  <span className="text-sm font-medium text-zinc-100 whitespace-nowrap">
                    {item.label}
                  </span>
                  <span className="text-xs text-zinc-500 truncate">· {item.detail}</span>
                </div>
                {item.ready ? (
                  <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-400 whitespace-nowrap shrink-0">
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    Ready
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-400 whitespace-nowrap shrink-0">
                    <AlertTriangle className="w-3.5 h-3.5" />
                    Needs Config
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="p-6 rounded-xl bg-[#12141B] border border-white/[0.08] flex flex-col justify-between">
          <div>
            <h2 className="text-base font-semibold text-white">Infrastructure Probe</h2>
            <p className="mt-0.5 text-xs text-zinc-400">
              Live server diagnostics from <code className="font-mono text-zinc-300">/api/health</code>.
            </p>

            <dl className="mt-5 space-y-3.5 text-xs">
              <div className="flex items-center justify-between gap-2">
                <dt className="text-zinc-400">Gemini AI</dt>
                <dd className={health?.gemini.configured ? 'text-emerald-400 font-medium' : 'text-amber-400 font-medium'}>
                  {health?.gemini.configured ? `Ready (${health.gemini.model})` : 'Key Missing'}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-2">
                <dt className="text-zinc-400">FFmpeg Binary</dt>
                <dd className={`font-mono tabular-nums ${health?.ffmpeg.available ? 'text-emerald-400' : 'text-red-400'}`}>
                  {health?.ffmpeg.available ? `v${health.ffmpeg.version?.split('-')[0]}` : 'Not Found'}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-2">
                <dt className="text-zinc-400">Persistence Store</dt>
                <dd className="text-zinc-200 font-mono">
                  {health?.database.provider === 'firestore' ? 'Firestore' : 'Local JSON'}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-2">
                <dt className="text-zinc-400">Cloud Storage</dt>
                <dd className={health?.storage.status === 'connected' ? 'text-emerald-400' : 'text-zinc-400'}>
                  {health?.storage.status === 'connected'
                    ? health.storage.bucketName
                    : 'Local Temp'}
                </dd>
              </div>
            </dl>
          </div>

          <button
            type="button"
            onClick={onNavigateSettings}
            className="mt-6 w-full inline-flex items-center justify-center gap-2 px-4 py-2 text-xs font-medium text-zinc-200 bg-[#181B24] border border-white/10 rounded-lg hover:bg-[#202430] transition-colors cursor-pointer"
          >
            Inspect Full Diagnostics
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>
      </section>

      {/* Recent Videos */}
      <section className="rounded-xl bg-[#12141B] border border-white/[0.08]">
        <div className="px-6 py-4 flex items-center justify-between gap-4 border-b border-white/[0.06]">
          <div>
            <h2 className="text-base font-semibold text-white">Recent Video Projects</h2>
            <p className="mt-0.5 text-xs text-zinc-400">
              Latest scripts, active jobs, and verified MP4 outputs.
            </p>
          </div>
          <button
            type="button"
            onClick={onNavigateLibrary}
            className="text-xs font-medium text-rose-400 hover:text-rose-300 inline-flex items-center gap-1 whitespace-nowrap shrink-0 cursor-pointer"
          >
            View All
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>

        {!summary || summary.recentVideos.length === 0 ? (
          <div className="px-6 py-14 text-center">
            <Film className="w-8 h-8 text-zinc-600 mx-auto" />
            <h3 className="mt-3 text-sm font-medium text-zinc-200">No video projects yet</h3>
            <p className="mt-1 text-xs text-zinc-500 max-w-md mx-auto">
              Generate your first short-form video from a topic, complete with TTS narration, visuals, subtitles, and FFmpeg MP4 export.
            </p>
            <button
              type="button"
              onClick={onNavigateCreate}
              className="mt-5 inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-rose-600 rounded-lg hover:bg-rose-500 transition-colors cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              Create First Video
            </button>
          </div>
        ) : (
          <div className="divide-y divide-white/[0.06]">
            {summary.recentVideos.map((video) => (
              <div
                key={video.id}
                className="px-6 py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4 hover:bg-white/[0.02] transition-colors"
              >
                <div className="min-w-0">
                  <button
                    type="button"
                    onClick={() => onOpenVideoScript(video.id)}
                    className="text-left text-sm font-medium text-white hover:text-rose-400 transition-colors truncate block max-w-full cursor-pointer"
                  >
                    {video.script?.title || video.topic}
                  </button>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-zinc-400">
                    <span>{CATEGORY_LABELS[video.category]}</span>
                    <span aria-hidden="true">·</span>
                    <span className="font-mono tabular-nums">
                      {video.output?.durationSeconds ??
                        video.script?.estimatedDurationSeconds ??
                        video.targetDurationSeconds}
                      s
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>{video.script?.scenes.length ?? 0} scenes</span>
                    <span aria-hidden="true">·</span>
                    <span className="font-mono tabular-nums">
                      {new Date(video.createdAt).toLocaleDateString()}
                    </span>
                  </div>
                </div>

                <div className="flex items-center gap-3 shrink-0">
                  <StatusLabel status={video.status} />
                  {video.output?.downloadUrl && (
                    <button
                      type="button"
                      disabled={downloadingId === video.id}
                      onClick={() => void handleDownload(video)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-rose-600 rounded-lg hover:bg-rose-500 disabled:opacity-60 transition-colors whitespace-nowrap cursor-pointer"
                    >
                      {downloadingId === video.id ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Download className="w-3.5 h-3.5" />
                      )}
                      {downloadingId === video.id ? 'Downloading...' : 'Download MP4'}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => onOpenVideoScript(video.id)}
                    className="px-3 py-1.5 text-xs font-medium text-zinc-200 bg-[#181B24] border border-white/10 rounded-lg hover:bg-[#222634] transition-colors cursor-pointer"
                  >
                    Open
                  </button>
                  {confirmDeleteId === video.id ? (
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => void handleDelete(video.id)}
                        className="px-2.5 py-1.5 text-xs font-medium text-white bg-red-600 rounded-lg hover:bg-red-500 cursor-pointer"
                      >
                        Confirm
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteId(null)}
                        className="px-2 py-1.5 text-xs text-zinc-400 hover:text-white cursor-pointer"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmDeleteId(video.id)}
                      aria-label={`Delete ${video.script?.title || video.topic}`}
                      className="p-1.5 text-zinc-500 hover:text-red-400 transition-colors cursor-pointer"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
