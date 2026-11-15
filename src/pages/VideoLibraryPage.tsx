import { useEffect, useState } from 'react';
import {
  Download,
  Eye,
  Film,
  Loader2,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { api } from '../lib/api';
import { downloadAuthorizedMp4 } from '../lib/media';
import {
  CATEGORY_LABELS,
  JOB_STATUSES,
  VIDEO_CATEGORIES,
  type VideoJob,
} from '../types';
import { StatusLabel } from '../components/StatusBadge';
import { AuthorizedImage, AuthorizedVideo } from '../components/AuthorizedMedia';

interface VideoLibraryPageProps {
  onOpenEditor: (videoId: string) => void;
  onNavigateCreate: () => void;
}

export function VideoLibraryPage({
  onOpenEditor,
  onNavigateCreate,
}: VideoLibraryPageProps) {
  const [videos, setVideos] = useState<VideoJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [previewVideo, setPreviewVideo] = useState<VideoJob | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  async function loadVideos() {
    setLoading(true);
    setError(null);
    try {
      const { videos: list } = await api.listVideos({
        status: statusFilter,
        category: categoryFilter,
      });
      setVideos(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load video library.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadVideos();
  }, [statusFilter, categoryFilter]);

  async function handleDelete(id: string) {
    try {
      await api.deleteVideo(id);
      setConfirmDeleteId(null);
      if (previewVideo?.id === id) setPreviewVideo(null);
      await loadVideos();
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

  const filtered = videos.filter((v) => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return true;
    const title = (v.script?.title || v.topic).toLowerCase();
    return title.includes(q) || v.topic.toLowerCase().includes(q);
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight text-white [text-wrap:balance]">
            Video Library
          </h1>
          <p className="mt-1 text-sm text-zinc-400">
            Preview rendered 1080×1920 MP4 exports, inspect media attribution, and download files.
          </p>
        </div>
      </div>

      {/* Filter Bar */}
      <div className="flex flex-col md:flex-row items-stretch md:items-center gap-3">
        <div className="relative flex-1">
          <Search className="w-4 h-4 text-zinc-500 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search by title or topic..."
            className="w-full pl-9 pr-3 py-2 text-xs text-white placeholder:text-zinc-500 bg-[#12141B] border border-white/[0.08] rounded-lg focus:outline-none focus:border-rose-500"
          />
        </div>

        <select
          aria-label="Filter by status"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="px-3 py-2 text-xs text-white bg-[#12141B] border border-white/[0.08] rounded-lg focus:outline-none focus:border-rose-500"
        >
          <option value="all">All Statuses</option>
          {JOB_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s.replace('_', ' ')}
            </option>
          ))}
        </select>

        <select
          aria-label="Filter by category"
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
          className="px-3 py-2 text-xs text-white bg-[#12141B] border border-white/[0.08] rounded-lg focus:outline-none focus:border-rose-500"
        >
          <option value="all">All Categories</option>
          {VIDEO_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {CATEGORY_LABELS[c]}
            </option>
          ))}
        </select>
      </div>

      {error && (
        <div className="p-4 rounded-lg bg-red-950/40 border border-red-500/30 text-xs text-red-200">
          {error}
        </div>
      )}

      {loading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5">
          {Array.from({ length: 4 }).map((_, idx) => (
            <div
              key={idx}
              className="h-80 rounded-xl bg-[#12141B] border border-white/[0.08] animate-pulse"
            />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="py-16 text-center rounded-xl bg-[#12141B] border border-white/[0.08]">
          <Film className="w-9 h-9 text-zinc-600 mx-auto" />
          <h2 className="mt-3 text-sm font-semibold text-zinc-200">No matching video records</h2>
          <p className="mt-1 text-xs text-zinc-500">
            Create a new short-form video or adjust your search filters.
          </p>
          <button
            type="button"
            onClick={onNavigateCreate}
            className="mt-5 px-4 py-2 text-xs font-semibold text-white bg-rose-600 rounded-lg hover:bg-rose-500 cursor-pointer"
          >
            Create Video
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5">
          {filtered.map((video) => {
            const hasMp4 = Boolean(video.output?.downloadUrl);
            return (
              <article
                key={video.id}
                className="flex flex-col rounded-xl bg-[#12141B] border border-white/[0.08] overflow-hidden"
              >
                {/* 9:16 Thumbnail Frame */}
                <div className="relative aspect-[9/12] bg-[#0E1016] border-b border-white/[0.06] overflow-hidden">
                  {video.output?.thumbnailUrl ? (
                    <>
                      <AuthorizedImage
                        src={video.output.thumbnailUrl}
                        alt={video.script?.title || video.topic}
                        referrerPolicy="no-referrer"
                        className="w-full h-full object-cover"
                      />
                      <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/30 to-black/40 p-4 flex flex-col justify-between">
                        <div className="flex items-center justify-between gap-2 text-[11px] font-mono tabular-nums text-zinc-200">
                          <span>{video.output.resolution}</span>
                          <span>{video.output.durationSeconds}s</span>
                        </div>
                        <div className="flex items-center justify-between">
                          <StatusLabel status={video.status} />
                          <span className="text-[11px] font-mono text-zinc-300">
                            {(video.output.fileSizeBytes / (1024 * 1024)).toFixed(1)} MB
                          </span>
                        </div>
                      </div>
                    </>
                  ) : (
                    <div className="w-full h-full p-4 flex flex-col justify-between">
                      <div className="flex items-center justify-between gap-2 text-[11px] font-mono tabular-nums text-zinc-500">
                        <span>9:16 · 1080×1920</span>
                        <span>
                          {video.script?.estimatedDurationSeconds ?? video.targetDurationSeconds}s
                        </span>
                      </div>

                      <div className="my-auto py-4">
                        <p className="text-[11px] font-medium text-rose-400">
                          {CATEGORY_LABELS[video.category]}
                        </p>
                        <p className="mt-1.5 text-sm font-semibold text-white line-clamp-3 leading-snug">
                          {video.script?.hook || video.topic}
                        </p>
                        <p className="mt-2 text-xs text-zinc-500">
                          {video.script
                            ? `${video.script.scenes.length} scenes planned`
                            : 'Pending script'}
                        </p>
                      </div>

                      <div className="flex items-center justify-between">
                        <StatusLabel status={video.status} />
                        <span className="text-[11px] font-mono text-zinc-500">
                          {video.source === 'scheduled' ? 'Auto' : 'Manual'}
                        </span>
                      </div>
                    </div>
                  )}
                </div>

                {/* Metadata & Actions */}
                <div className="p-4 flex-1 flex flex-col justify-between gap-4">
                  <div>
                    <h3 className="text-sm font-semibold text-white line-clamp-2">
                      {video.script?.title || video.topic}
                    </h3>
                    <p className="mt-1 text-xs text-zinc-400 font-mono tabular-nums">
                      {new Date(video.createdAt).toLocaleString()}
                    </p>
                  </div>

                  <div className="flex items-center gap-2 pt-2 border-t border-white/[0.06]">
                    <button
                      type="button"
                      onClick={() => setPreviewVideo(video)}
                      className="flex-1 inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-zinc-200 bg-[#181B24] border border-white/10 rounded-lg hover:bg-[#222736] cursor-pointer"
                    >
                      <Eye className="w-3.5 h-3.5" />
                      Preview
                    </button>

                    {hasMp4 ? (
                      <button
                        type="button"
                        disabled={downloadingId === video.id}
                        onClick={() => void handleDownload(video)}
                        className="flex-1 inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 text-xs font-semibold text-white bg-rose-600 rounded-lg hover:bg-rose-500 disabled:opacity-60 cursor-pointer"
                      >
                        {downloadingId === video.id ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Download className="w-3.5 h-3.5" />
                        )}
                        {downloadingId === video.id ? 'Saving...' : 'Download'}
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => onOpenEditor(video.id)}
                        className="flex-1 inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-rose-300 bg-rose-950/30 border border-rose-500/30 rounded-lg hover:bg-rose-950/50 cursor-pointer"
                      >
                        Edit / Render
                      </button>
                    )}

                    {confirmDeleteId === video.id ? (
                      <button
                        type="button"
                        onClick={() => void handleDelete(video.id)}
                        className="px-2.5 py-1.5 text-xs font-semibold text-white bg-red-600 rounded-lg hover:bg-red-500 cursor-pointer"
                      >
                        Confirm
                      </button>
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
              </article>
            );
          })}
        </div>
      )}

      {/* Preview Modal */}
      {previewVideo && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Video output preview"
        >
          <div className="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-xl bg-[#12141B] border border-white/10 p-6 space-y-5">
            <div className="flex items-start justify-between gap-4 pb-4 border-b border-white/[0.06]">
              <div>
                <StatusLabel status={previewVideo.status} />
                <h2 className="mt-2 text-lg font-semibold text-white">
                  {previewVideo.script?.title || previewVideo.topic}
                </h2>
                <p className="mt-1 text-xs text-zinc-400">
                  {CATEGORY_LABELS[previewVideo.category]} · Voice: {previewVideo.voiceId} ·{' '}
                  {previewVideo.output?.durationSeconds ??
                    previewVideo.script?.estimatedDurationSeconds ??
                    previewVideo.targetDurationSeconds}
                  s
                </p>
              </div>
              <button
                type="button"
                onClick={() => setPreviewVideo(null)}
                aria-label="Close preview"
                className="p-1.5 text-zinc-400 hover:text-white cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {previewVideo.output?.streamUrl ? (
              <div className="space-y-3">
                <AuthorizedVideo
                  src={previewVideo.output.streamUrl}
                  poster={previewVideo.output.thumbnailUrl}
                  controls
                  playsInline
                  className="w-full max-h-[440px] rounded-lg bg-black aspect-[9/16] mx-auto"
                />
                <p className="text-center text-xs font-mono text-zinc-400">
                  {previewVideo.output.resolution} · {previewVideo.output.videoCodec}/
                  {previewVideo.output.audioCodec} ·{' '}
                  {(previewVideo.output.fileSizeBytes / (1024 * 1024)).toFixed(2)} MB
                  {previewVideo.output.gcsUri ? ` · ${previewVideo.output.gcsUri}` : ''}
                </p>
              </div>
            ) : (
              <div className="p-4 rounded-lg bg-[#171A23] border border-white/[0.06] text-xs text-zinc-300">
                No verified MP4 file has been rendered for this project yet. Open it in Studio to render the MP4.
              </div>
            )}

            {previewVideo.script && (
              <div className="space-y-3">
                <h3 className="text-xs font-semibold text-zinc-300">Scenes & Media Sources</h3>
                <div className="space-y-2.5">
                  {previewVideo.script.scenes.map((scene) => (
                    <div
                      key={scene.id}
                      className="p-3 rounded-lg bg-[#171A23] border border-white/[0.06] text-xs space-y-1"
                    >
                      <div className="flex items-center justify-between text-zinc-400 font-mono tabular-nums">
                        <span className="text-rose-400 font-semibold">
                          Scene {String(scene.sceneNumber).padStart(2, '0')}
                        </span>
                        <span>
                          {scene.durationSeconds}s · {scene.assetSource}
                        </span>
                      </div>
                      <p className="text-white">{scene.narrationText}</p>
                      {scene.attribution && (
                        <p className="text-zinc-400">Media: {scene.attribution}</p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="flex items-center justify-end gap-3 pt-2 border-t border-white/[0.06]">
              {previewVideo.output?.downloadUrl && (
                <button
                  type="button"
                  disabled={downloadingId === previewVideo.id}
                  onClick={() => void handleDownload(previewVideo)}
                  className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-rose-600 rounded-lg hover:bg-rose-500 disabled:opacity-60 cursor-pointer"
                >
                  {downloadingId === previewVideo.id ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Download className="w-3.5 h-3.5" />
                  )}
                  {downloadingId === previewVideo.id ? 'Downloading...' : 'Download MP4'}
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  const id = previewVideo.id;
                  setPreviewVideo(null);
                  onOpenEditor(id);
                }}
                className="px-4 py-2 text-xs font-medium text-zinc-200 bg-[#181B24] border border-white/10 rounded-lg hover:bg-[#222736] cursor-pointer"
              >
                Open in Studio
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
