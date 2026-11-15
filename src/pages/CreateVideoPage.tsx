import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clapperboard,
  Download,
  Film,
  Loader2,
  Plus,
  RefreshCw,
  Save,
  Sparkles,
  Trash2,
  Wand2,
} from 'lucide-react';
import { api, ApiClientError } from '../lib/api';
import {
  CATEGORY_LABELS,
  VIDEO_CATEGORIES,
  VOICE_OPTIONS,
  type ScenePlanItem,
  type TopicSuggestion,
  type VideoCategory,
  type VideoJob,
  type VideoScript,
  type VisualMode,
} from '../types';
import { StatusLabel } from '../components/StatusBadge';
import {
  AuthorizedAudio,
  AuthorizedImage,
  AuthorizedVideo,
} from '../components/AuthorizedMedia';
import { downloadAuthorizedMp4 } from '../lib/media';

interface CreateVideoPageProps {
  selectedVideoId: string | null;
  resetNonce?: number;
  onVideoCreatedOrSelected: (videoId: string) => void;
}

const DURATION_OPTIONS = [30, 45, 60] as const;

const VISUAL_MODE_OPTIONS: Array<{ id: VisualMode; label: string }> = [
  { id: 'stock_auto', label: 'Auto Stock Media (Pexels / Pixabay / Wikimedia)' },
  { id: 'wikimedia', label: 'Wikimedia Commons (Free Open License)' },
  { id: 'pexels', label: 'Pexels Stock Video & Photo (Requires PEXELS_API_KEY)' },
  { id: 'pixabay', label: 'Pixabay Stock Video & Photo (Requires PIXABAY_API_KEY)' },
  { id: 'ai_image', label: 'Gemini AI Image Generation (Requires Paid Billing)' },
];

function formatAssetOrigin(scene: ScenePlanItem): string {
  if (scene.assetSource === 'ai_image') {
    return `AI Generated · ${scene.providerName || 'Gemini Image'}`;
  }
  if (scene.assetSource === 'stock_video') {
    return `Stock Video · ${scene.providerName || 'Stock Provider'}`;
  }
  if (scene.assetSource === 'stock_image') {
    return `Stock Image · ${scene.providerName || 'Stock Provider'}`;
  }
  return 'Visual unassigned';
}

export function CreateVideoPage({
  selectedVideoId,
  resetNonce = 0,
  onVideoCreatedOrSelected,
}: CreateVideoPageProps) {
  const [category, setCategory] = useState<VideoCategory>('educational');
  const [duration, setDuration] = useState<number>(45);
  const [voiceId, setVoiceId] = useState<string>('Kore');
  const [visualMode, setVisualMode] = useState<VisualMode>('stock_auto');
  const [topic, setTopic] = useState<string>('');

  const [suggestions, setSuggestions] = useState<TopicSuggestion[]>([]);
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);

  const [generatingScript, setGeneratingScript] = useState(false);
  const [startingRender, setStartingRender] = useState(false);
  const [downloadingMp4, setDownloadingMp4] = useState(false);
  const [generationStageText, setGenerationStageText] = useState<string>('');

  const [activeVideo, setActiveVideo] = useState<VideoJob | null>(null);
  const [editableScript, setEditableScript] = useState<VideoScript | null>(null);
  const [savingScript, setSavingScript] = useState(false);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);

  const [errorState, setErrorState] = useState<{
    message: string;
    code: string;
    retryable: boolean;
    action: 'suggest' | 'generate' | 'save' | 'render' | 'load' | 'download';
  } | null>(null);

  useEffect(() => {
    if (resetNonce > 0 && !selectedVideoId) {
      setActiveVideo(null);
      setEditableScript(null);
      setTopic('');
      setSuggestions([]);
      setSaveNotice(null);
      setErrorState(null);
      setGeneratingScript(false);
      setStartingRender(false);
      setGenerationStageText('');
    }
  }, [resetNonce, selectedVideoId]);

  useEffect(() => {
    if (!selectedVideoId || activeVideo?.id === selectedVideoId) return;
    let cancelled = false;
    async function loadSelected() {
      try {
        const { video } = await api.getVideo(selectedVideoId!);
        if (cancelled) return;
        setActiveVideo(video);
        setEditableScript(video.script ? structuredClone(video.script) : null);
        setCategory(video.category);
        setDuration(video.targetDurationSeconds);
        setVoiceId(video.voiceId);
        setVisualMode(video.visualMode || 'stock_auto');
        setTopic(video.topic);
        setSaveNotice(null);
      } catch (err) {
        if (!cancelled) {
          setErrorState({
            message: err instanceof Error ? err.message : 'Failed to load video job',
            code: 'LOAD_ERROR',
            retryable: true,
            action: 'load',
          });
        }
      }
    }
    void loadSelected();
    return () => {
      cancelled = true;
    };
  }, [selectedVideoId]);

  // Poll active rendering job for live progress
  useEffect(() => {
    if (!activeVideo || (activeVideo.status !== 'processing' && activeVideo.status !== 'queued')) {
      return;
    }

    let cancelled = false;
    const interval = window.setInterval(async () => {
      try {
        const { video } = await api.getVideo(activeVideo.id);
        if (cancelled) return;
        setActiveVideo(video);
        if (video.script) {
          setEditableScript(structuredClone(video.script));
        }
        if (video.status === 'failed' && video.error) {
          setErrorState({
            message: video.error.message,
            code: video.error.code,
            retryable: video.error.retryable,
            action: 'render',
          });
        }
      } catch {
        // Ignore transient poll hiccup
      }
    }, 1500);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [activeVideo?.id, activeVideo?.status]);

  async function handleSuggestTopics() {
    setLoadingSuggestions(true);
    setErrorState(null);
    try {
      const { suggestions: list } = await api.suggestTopics(category);
      setSuggestions(list);
    } catch (err) {
      if (err instanceof ApiClientError) {
        setErrorState({
          message: err.message,
          code: err.code,
          retryable: err.retryable,
          action: 'suggest',
        });
      } else {
        setErrorState({
          message: 'Failed to request topic suggestions from Gemini.',
          code: 'UNKNOWN',
          retryable: true,
          action: 'suggest',
        });
      }
    } finally {
      setLoadingSuggestions(false);
    }
  }

  async function handleGenerateScript(autoStartRender = false) {
    if (topic.trim().length < 3) {
      setErrorState({
        message: 'Enter a topic of at least 3 characters or pick one from Gemini suggestions.',
        code: 'INVALID_TOPIC',
        retryable: false,
        action: 'generate',
      });
      document.getElementById('topic-input')?.focus();
      return;
    }

    setGeneratingScript(true);
    setErrorState(null);
    setSaveNotice(null);
    setGenerationStageText('Researching facts and narrative angles...');

    const stageTimer = window.setTimeout(() => {
      setGenerationStageText('Writing script hook, body, ending, and scene plan...');
    }, 1800);

    try {
      const { video } = await api.generateScript({
        topic: topic.trim(),
        category,
        targetDurationSeconds: duration,
        voiceId,
        visualMode,
      });
      setActiveVideo(video);
      setEditableScript(video.script ? structuredClone(video.script) : null);
      onVideoCreatedOrSelected(video.id);

      if (autoStartRender) {
        setGenerationStageText('Starting TTS narration, visual acquisition, and FFmpeg MP4 render...');
        const { video: queued } = await api.triggerRender(video.id, { voiceId, visualMode });
        setActiveVideo(queued);
      }
    } catch (err) {
      if (err instanceof ApiClientError) {
        setErrorState({
          message: err.message,
          code: err.code,
          retryable: err.retryable,
          action: 'generate',
        });
      } else {
        setErrorState({
          message: 'Failed to generate script.',
          code: 'UNKNOWN',
          retryable: true,
          action: 'generate',
        });
      }
    } finally {
      window.clearTimeout(stageTimer);
      setGeneratingScript(false);
      setGenerationStageText('');
    }
  }

  async function handleSaveScript() {
    if (!activeVideo || !editableScript) return;
    setSavingScript(true);
    setSaveNotice(null);
    setErrorState(null);
    try {
      const { video } = await api.saveScript(activeVideo.id, editableScript, {
        voiceId,
        visualMode,
      });
      setActiveVideo(video);
      setEditableScript(video.script ? structuredClone(video.script) : null);
      setSaveNotice('Script and scene plan saved.');
    } catch (err) {
      setErrorState({
        message: err instanceof Error ? err.message : 'Failed to save script changes.',
        code: 'SAVE_ERROR',
        retryable: true,
        action: 'save',
      });
    } finally {
      setSavingScript(false);
    }
  }

  async function handleRenderVideo() {
    if (!activeVideo || !editableScript) return;
    setStartingRender(true);
    setErrorState(null);
    setSaveNotice(null);

    try {
      // Persist any unsaved script edits before starting render
      await api.saveScript(activeVideo.id, editableScript, { voiceId, visualMode });
      const { video: queued } = await api.triggerRender(activeVideo.id, { voiceId, visualMode });
      setActiveVideo(queued);
    } catch (err) {
      if (err instanceof ApiClientError) {
        setErrorState({
          message: err.message,
          code: err.code,
          retryable: err.retryable,
          action: 'render',
        });
      } else {
        setErrorState({
          message: 'Failed to start MP4 rendering pipeline.',
          code: 'RENDER_START_FAILED',
          retryable: true,
          action: 'render',
        });
      }
    } finally {
      setStartingRender(false);
    }
  }
  async function handleDownloadMp4() {
    if (!activeVideo?.output?.downloadUrl) return;
    setDownloadingMp4(true);
    setErrorState(null);
    try {
      await downloadAuthorizedMp4(
        activeVideo.output.downloadUrl,
        editableScript?.title || activeVideo.topic
      );
    } catch (err) {
      setErrorState({
        message: err instanceof Error ? err.message : 'Failed to download MP4 file.',
        code: 'DOWNLOAD_FAILED',
        retryable: true,
        action: 'download',
      });
    } finally {
      setDownloadingMp4(false);
    }
  }
  function updateScene(sceneId: string, patch: Partial<ScenePlanItem>) {
    if (!editableScript) return;
    setEditableScript({
      ...editableScript,
      scenes: editableScript.scenes.map((s) => (s.id === sceneId ? { ...s, ...patch } : s)),
    });
  }

  function addScene() {
    if (!editableScript) return;
    const nextNum = editableScript.scenes.length + 1;
    const newScene: ScenePlanItem = {
      id: crypto.randomUUID(),
      sceneNumber: nextNum,
      durationSeconds: 5,
      narrationText: '',
      subtitleText: '',
      visualPrompt: '',
      stockKeywords: [],
      transition: 'cut',
      soundEffectCue: 'none',
      assetSource: 'unassigned',
    };
    setEditableScript({
      ...editableScript,
      scenes: [...editableScript.scenes, newScene],
    });
  }

  function removeScene(sceneId: string) {
    if (!editableScript || editableScript.scenes.length <= 1) return;
    const remaining = editableScript.scenes
      .filter((s) => s.id !== sceneId)
      .map((s, idx) => ({ ...s, sceneNumber: idx + 1 }));
    setEditableScript({
      ...editableScript,
      scenes: remaining,
    });
  }

  const isRendering =
    activeVideo?.status === 'processing' || activeVideo?.status === 'queued';

  const computedTotalDuration = editableScript
    ? Math.round(
        editableScript.scenes.reduce((acc, s) => acc + (Number(s.durationSeconds) || 0), 0)
      )
    : 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight text-white [text-wrap:balance]">
          Create Short-Form Video
        </h1>
        <p className="mt-1 text-sm text-zinc-400">
          Generate researched scripts, review scenes, synthesize TTS narration, acquire visuals, and export 1080×1920 MP4s.
        </p>
      </div>

      {errorState && (
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-4 rounded-xl bg-red-950/40 border border-red-500/30 text-sm text-red-200">
          <div className="flex items-start gap-2.5">
            <AlertTriangle className="w-4 h-4 text-red-400 mt-0.5 shrink-0" />
            <div>
              <p className="font-medium text-red-100">{errorState.message}</p>
              <p className="mt-0.5 text-xs font-mono text-red-300/80">
                Code: {errorState.code}
                {!errorState.retryable && ' · Automatic retry disabled'}
              </p>
            </div>
          </div>
          {errorState.retryable && (
            <button
              type="button"
              onClick={() => {
                if (errorState.action === 'suggest') void handleSuggestTopics();
                else if (errorState.action === 'generate') void handleGenerateScript(false);
                else if (errorState.action === 'save') void handleSaveScript();
                else if (errorState.action === 'render') void handleRenderVideo();
                else if (errorState.action === 'download') void handleDownloadMp4();
              }}
              className="px-3 py-1.5 text-xs font-medium text-white bg-red-600 rounded-lg hover:bg-red-500 whitespace-nowrap shrink-0 cursor-pointer"
            >
              Retry
            </button>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
        {/* Left column: Topic & Parameters */}
        <section className="xl:col-span-5 space-y-5 p-6 rounded-xl bg-[#12141B] border border-white/[0.08]">
          <div>
            <label className="block text-xs font-medium text-zinc-300 mb-2">
              Content Category
            </label>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {VIDEO_CATEGORIES.map((cat) => (
                <button
                  key={cat}
                  type="button"
                  disabled={isRendering}
                  onClick={() => setCategory(cat)}
                  className={`px-3 py-2 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap cursor-pointer disabled:opacity-50 ${
                    category === cat
                      ? 'bg-rose-600/15 border-rose-500 text-white'
                      : 'bg-[#171A23] border-white/[0.08] text-zinc-400 hover:text-zinc-200 hover:border-white/20'
                  }`}
                >
                  {CATEGORY_LABELS[cat]}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-zinc-300 mb-2">
                Target Duration
              </label>
              <div className="flex items-center gap-1 p-1 rounded-lg bg-[#171A23] border border-white/[0.08]">
                {DURATION_OPTIONS.map((sec) => (
                  <button
                    key={sec}
                    type="button"
                    disabled={isRendering}
                    onClick={() => setDuration(sec)}
                    className={`flex-1 py-1.5 text-xs font-mono tabular-nums font-medium rounded-md transition-colors cursor-pointer disabled:opacity-50 ${
                      duration === sec
                        ? 'bg-rose-600 text-white'
                        : 'text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    {sec}s
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label htmlFor="voice-select" className="block text-xs font-medium text-zinc-300 mb-2">
                Narration Voice (Gemini TTS)
              </label>
              <select
                id="voice-select"
                disabled={isRendering}
                value={voiceId}
                onChange={(e) => setVoiceId(e.target.value)}
                className="w-full px-3 py-2 text-xs text-white bg-[#171A23] border border-white/[0.08] rounded-lg focus:outline-none focus:border-rose-500 disabled:opacity-50"
              >
                {VOICE_OPTIONS.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.label} — {v.description}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label htmlFor="visual-mode-select" className="block text-xs font-medium text-zinc-300 mb-2">
              Visual Media Source
            </label>
            <select
              id="visual-mode-select"
              disabled={isRendering}
              value={visualMode}
              onChange={(e) => setVisualMode(e.target.value as VisualMode)}
              className="w-full px-3 py-2 text-xs text-white bg-[#171A23] border border-white/[0.08] rounded-lg focus:outline-none focus:border-rose-500 disabled:opacity-50"
            >
              {VISUAL_MODE_OPTIONS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>

          {/* Topic Input + Auto Topic Discovery */}
          <div className="pt-4 border-t border-white/[0.06] space-y-3">
            <div className="flex items-center justify-between gap-2">
              <label htmlFor="topic-input" className="text-xs font-medium text-zinc-300">
                Video Topic
              </label>
              <button
                type="button"
                disabled={loadingSuggestions || isRendering}
                onClick={() => void handleSuggestTopics()}
                className="inline-flex items-center gap-1.5 text-xs font-medium text-rose-400 hover:text-rose-300 disabled:opacity-50 whitespace-nowrap shrink-0 cursor-pointer"
              >
                {loadingSuggestions ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Sparkles className="w-3.5 h-3.5" />
                )}
                {loadingSuggestions ? 'Thinking...' : 'Suggest Topics with Gemini'}
              </button>
            </div>

            <textarea
              id="topic-input"
              rows={3}
              disabled={isRendering}
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder="Enter a specific topic or pick an automated Gemini suggestion below..."
              className="w-full px-3.5 py-2.5 text-sm text-white placeholder:text-zinc-500 bg-[#171A23] border border-white/[0.08] rounded-lg focus:outline-none focus:border-rose-500 resize-none disabled:opacity-50"
            />

            {suggestions.length > 0 && (
              <div className="space-y-2 pt-1">
                <p className="text-xs text-zinc-400">
                  Fresh suggestions for {CATEGORY_LABELS[category]} (click to load):
                </p>
                <div className="space-y-2">
                  {suggestions.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      disabled={isRendering}
                      onClick={() => setTopic(item.topic)}
                      className={`w-full text-left p-3 rounded-lg border transition-colors cursor-pointer ${
                        topic === item.topic
                          ? 'bg-rose-600/10 border-rose-500/60'
                          : 'bg-[#171A23] border-white/[0.06] hover:border-white/20'
                      }`}
                    >
                      <p className="text-xs font-semibold text-white">{item.topic}</p>
                      <p className="mt-1 text-xs text-zinc-400 line-clamp-2">{item.angle}</p>
                      <p className="mt-1.5 text-[11px] text-zinc-500 italic">
                        "{item.hookPreview}"
                      </p>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Primary Actions */}
          <div className="pt-2 space-y-2.5">
            <button
              type="button"
              disabled={generatingScript || isRendering}
              onClick={() => void handleGenerateScript(true)}
              className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-semibold text-white bg-rose-600 rounded-lg hover:bg-rose-500 disabled:opacity-60 transition-colors cursor-pointer"
            >
              {generatingScript ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Film className="w-4 h-4" />
              )}
              {generatingScript ? 'Generating Script...' : 'Generate Video (Full Pipeline)'}
            </button>

            <button
              type="button"
              disabled={generatingScript || isRendering}
              onClick={() => void handleGenerateScript(false)}
              className="w-full inline-flex items-center justify-center gap-2 px-4 py-2 text-xs font-medium text-zinc-200 bg-[#171A23] border border-white/10 rounded-lg hover:bg-[#1E222E] disabled:opacity-50 transition-colors cursor-pointer"
            >
              <Wand2 className="w-3.5 h-3.5" />
              Generate Script Only (Edit Before Rendering)
            </button>

            {generatingScript && generationStageText && (
              <p className="pt-1 text-xs text-center text-zinc-400">{generationStageText}</p>
            )}
          </div>
        </section>

        {/* Right column: Live Pipeline Progress, Rendered MP4 Player, Research & Scene Studio */}
        <section className="xl:col-span-7 p-6 rounded-xl bg-[#12141B] border border-white/[0.08]">
          {!activeVideo || !editableScript ? (
            <div className="py-20 text-center">
              <Clapperboard className="w-10 h-10 text-zinc-600 mx-auto" />
              <h2 className="mt-4 text-base font-semibold text-zinc-200">
                Production & Scene Studio
              </h2>
              <p className="mt-1.5 text-xs text-zinc-500 max-w-md mx-auto leading-relaxed">
                Click "Generate Video (Full Pipeline)" for one-click MP4 production, or "Generate Script Only" to review and edit scenes before rendering.
              </p>
            </div>
          ) : (
            <div className="space-y-6">
              {/* Header & Save/Render actions */}
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-white/[0.06]">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-3">
                    <StatusLabel status={activeVideo.status} />
                    <span className="text-xs text-zinc-500 font-mono tabular-nums">
                      {computedTotalDuration}s · {editableScript.scenes.length} scenes
                    </span>
                  </div>
                  <input
                    type="text"
                    disabled={isRendering}
                    value={editableScript.title}
                    onChange={(e) =>
                      setEditableScript({ ...editableScript, title: e.target.value })
                    }
                    aria-label="Video title"
                    className="mt-2 w-full text-lg font-semibold text-white bg-transparent border-b border-transparent hover:border-white/10 focus:border-rose-500 focus:outline-none pb-0.5 disabled:opacity-60"
                  />
                </div>

                <div className="flex items-center gap-2.5 shrink-0">
                  <button
                    type="button"
                    disabled={savingScript || isRendering}
                    onClick={() => void handleSaveScript()}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-white bg-[#181B24] border border-white/15 rounded-lg hover:bg-[#222736] disabled:opacity-50 whitespace-nowrap cursor-pointer"
                  >
                    {savingScript ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Save className="w-3.5 h-3.5" />
                    )}
                    Save Script
                  </button>
                  <button
                    type="button"
                    disabled={startingRender || isRendering}
                    onClick={() => void handleRenderVideo()}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-rose-600 rounded-lg hover:bg-rose-500 disabled:opacity-60 whitespace-nowrap cursor-pointer"
                  >
                    {isRendering || startingRender ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <RefreshCw className="w-3.5 h-3.5" />
                    )}
                    {isRendering
                      ? 'Rendering...'
                      : activeVideo.status === 'completed'
                        ? 'Re-Render MP4'
                        : 'Render MP4'}
                  </button>
                </div>
              </div>

              {/* Live Progress Bar during rendering */}
              {isRendering && (
                <div className="p-4 rounded-lg bg-[#171A23] border border-rose-500/30 space-y-2.5">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-medium text-white">{activeVideo.currentStage}</span>
                    <span className="font-mono tabular-nums text-rose-400">
                      {activeVideo.progressPercent}%
                    </span>
                  </div>
                  <div className="w-full h-1.5 bg-white/10 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-rose-500 transition-all duration-300"
                      style={{ width: `${Math.min(100, Math.max(5, activeVideo.progressPercent))}%` }}
                    />
                  </div>
                </div>
              )}

              {/* Verified MP4 Preview & Download */}
              {activeVideo.status === 'completed' && activeVideo.output && (
                <div className="p-5 rounded-xl bg-[#171A23] border border-emerald-500/30 grid grid-cols-1 md:grid-cols-12 gap-5 items-center">
                  <div className="md:col-span-5">
                    <AuthorizedVideo
                      key={activeVideo.output.verifiedAt}
                      src={activeVideo.output.streamUrl}
                      poster={activeVideo.output.thumbnailUrl}
                      controls
                      playsInline
                      className="w-full max-h-[340px] rounded-lg bg-black aspect-[9/16] mx-auto"
                    />
                  </div>
                  <div className="md:col-span-7 space-y-3">
                    <div className="flex items-center gap-2 text-xs font-semibold text-emerald-400">
                      <CheckCircle2 className="w-4 h-4" />
                      <span>Verified MP4 Ready</span>
                    </div>
                    <h3 className="text-base font-semibold text-white">
                      {editableScript.title}
                    </h3>
                    <dl className="grid grid-cols-2 gap-2.5 text-xs">
                      <div>
                        <dt className="text-zinc-500">Resolution</dt>
                        <dd className="font-mono text-zinc-200">{activeVideo.output.resolution}</dd>
                      </div>
                      <div>
                        <dt className="text-zinc-500">Duration</dt>
                        <dd className="font-mono tabular-nums text-zinc-200">
                          {activeVideo.output.durationSeconds}s
                        </dd>
                      </div>
                      <div>
                        <dt className="text-zinc-500">File Size</dt>
                        <dd className="font-mono tabular-nums text-zinc-200">
                          {(activeVideo.output.fileSizeBytes / (1024 * 1024)).toFixed(2)} MB
                        </dd>
                      </div>
                      <div>
                        <dt className="text-zinc-500">Codecs</dt>
                        <dd className="font-mono text-zinc-200">
                          {activeVideo.output.videoCodec} / {activeVideo.output.audioCodec}
                        </dd>
                      </div>
                    </dl>
                    <div className="pt-2">
                      <button
                        type="button"
                        disabled={downloadingMp4}
                        onClick={() => void handleDownloadMp4()}
                        className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-rose-600 rounded-lg hover:bg-rose-500 disabled:opacity-60 transition-colors cursor-pointer"
                      >
                        {downloadingMp4 ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Download className="w-3.5 h-3.5" />
                        )}
                        {downloadingMp4 ? 'Downloading...' : 'Download MP4'}
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {saveNotice && (
                <div className="flex items-center gap-2 p-3 rounded-lg bg-emerald-950/40 border border-emerald-500/30 text-xs text-emerald-200">
                  <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                  <span>{saveNotice}</span>
                </div>
              )}

              {/* Research Brief */}
              <div className="p-4 rounded-lg bg-[#171A23] border border-white/[0.06] space-y-2.5">
                <h3 className="text-xs font-semibold text-zinc-200">Research Brief</h3>
                <p className="text-xs text-zinc-300 leading-relaxed">
                  {editableScript.researchSummary}
                </p>
                {editableScript.keyFacts.length > 0 && (
                  <ul className="pt-1 space-y-1 text-xs text-zinc-400 list-disc list-inside">
                    {editableScript.keyFacts.map((fact, idx) => (
                      <li key={idx}>{fact}</li>
                    ))}
                  </ul>
                )}
              </div>

              {/* Scene-by-Scene Plan with Real Asset & Narration Previews */}
              <div className="pt-4 border-t border-white/[0.06] space-y-4">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <h3 className="text-sm font-semibold text-white">Scene-by-Scene Plan</h3>
                    <p className="text-xs text-zinc-400">
                      Edit narration, visual prompts, stock keywords, and inspect acquired media per scene.
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={isRendering}
                    onClick={addScene}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-zinc-200 bg-[#181B24] border border-white/10 rounded-lg hover:bg-[#222634] disabled:opacity-50 whitespace-nowrap cursor-pointer"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    Add Scene
                  </button>
                </div>

                <div className="space-y-4">
                  {editableScript.scenes.map((scene) => (
                    <div
                      key={scene.id}
                      className="p-4 rounded-lg bg-[#171A23] border border-white/[0.06] space-y-3"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="flex flex-wrap items-center gap-3">
                          <span className="font-mono text-xs font-semibold text-rose-400 tabular-nums">
                            Scene {String(scene.sceneNumber).padStart(2, '0')}
                          </span>
                          <span className="text-[11px] text-zinc-400">
                            {formatAssetOrigin(scene)}
                          </span>
                          <label className="inline-flex items-center gap-1.5 text-xs text-zinc-400">
                            <span>Duration (s):</span>
                            <input
                              type="number"
                              min={1}
                              max={30}
                              step={0.5}
                              disabled={isRendering}
                              value={scene.durationSeconds}
                              onChange={(e) =>
                                updateScene(scene.id, {
                                  durationSeconds: Number(e.target.value) || 1,
                                })
                              }
                              className="w-16 px-2 py-1 text-xs font-mono tabular-nums text-white bg-[#12141B] border border-white/10 rounded focus:outline-none focus:border-rose-500"
                            />
                          </label>
                          <label className="inline-flex items-center gap-1.5 text-xs text-zinc-400">
                            <span>Transition:</span>
                            <select
                              disabled={isRendering}
                              value={scene.transition}
                              onChange={(e) =>
                                updateScene(scene.id, {
                                  transition: e.target.value as ScenePlanItem['transition'],
                                })
                              }
                              className="px-2 py-1 text-xs text-white bg-[#12141B] border border-white/10 rounded focus:outline-none focus:border-rose-500"
                            >
                              <option value="cut">Cut</option>
                              <option value="crossfade">Crossfade</option>
                              <option value="zoom">Zoom</option>
                            </select>
                          </label>
                        </div>

                        {editableScript.scenes.length > 1 && !isRendering && (
                          <button
                            type="button"
                            onClick={() => removeScene(scene.id)}
                            aria-label={`Remove scene ${scene.sceneNumber}`}
                            className="p-1 text-zinc-500 hover:text-red-400 transition-colors cursor-pointer"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>

                      {/* Real Acquired Media & TTS Audio Preview if generated */}
                      {(scene.assetUrl || scene.audioUrl) && (
                        <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3 p-3 rounded-lg bg-[#12141B] border border-white/[0.06]">
                          {scene.assetUrl && (
                            <div className="w-16 h-24 rounded overflow-hidden bg-black shrink-0 border border-white/10">
                              {scene.assetSource === 'stock_video' ? (
                                <AuthorizedVideo
                                  src={scene.assetUrl}
                                  muted
                                  loop
                                  autoPlay
                                  playsInline
                                  className="w-full h-full object-cover"
                                />
                              ) : (
                                <AuthorizedImage
                                  src={scene.assetUrl}
                                  alt={`Scene ${scene.sceneNumber} visual`}
                                  referrerPolicy="no-referrer"
                                  className="w-full h-full object-cover"
                                />
                              )}
                            </div>
                          )}
                          <div className="flex-1 min-w-0 space-y-2 w-full">
                            {scene.attribution && (
                              <p className="text-[11px] text-zinc-400 truncate">
                                {scene.attribution}
                              </p>
                            )}
                            {scene.audioUrl && (
                              <AuthorizedAudio
                                src={scene.audioUrl}
                                controls
                                className="w-full h-8"
                              />
                            )}
                          </div>
                        </div>
                      )}

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        <div>
                          <label className="block text-[11px] font-medium text-zinc-400 mb-1">
                            Spoken Narration
                          </label>
                          <textarea
                            rows={3}
                            disabled={isRendering}
                            value={scene.narrationText}
                            onChange={(e) =>
                              updateScene(scene.id, { narrationText: e.target.value })
                            }
                            className="w-full px-3 py-2 text-xs text-white bg-[#12141B] border border-white/[0.08] rounded-lg focus:outline-none focus:border-rose-500"
                          />
                        </div>
                        <div>
                          <label className="block text-[11px] font-medium text-zinc-400 mb-1">
                            9:16 Visual Prompt
                          </label>
                          <textarea
                            rows={3}
                            disabled={isRendering}
                            value={scene.visualPrompt}
                            onChange={(e) =>
                              updateScene(scene.id, { visualPrompt: e.target.value })
                            }
                            className="w-full px-3 py-2 text-xs text-white bg-[#12141B] border border-white/[0.08] rounded-lg focus:outline-none focus:border-rose-500"
                          />
                        </div>
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        <div>
                          <label className="block text-[11px] font-medium text-zinc-400 mb-1">
                            On-Screen Subtitle Line
                          </label>
                          <input
                            type="text"
                            disabled={isRendering}
                            value={scene.subtitleText}
                            onChange={(e) =>
                              updateScene(scene.id, { subtitleText: e.target.value })
                            }
                            className="w-full px-3 py-1.5 text-xs text-white bg-[#12141B] border border-white/[0.08] rounded-lg focus:outline-none focus:border-rose-500"
                          />
                        </div>
                        <div>
                          <label className="block text-[11px] font-medium text-zinc-400 mb-1">
                            Stock Keywords & Audio Cue
                          </label>
                          <div className="flex items-center gap-2">
                            <input
                              type="text"
                              disabled={isRendering}
                              value={scene.stockKeywords.join(', ')}
                              onChange={(e) =>
                                updateScene(scene.id, {
                                  stockKeywords: e.target.value
                                    .split(',')
                                    .map((k) => k.trim())
                                    .filter(Boolean),
                                })
                              }
                              placeholder="comma separated keywords"
                              className="flex-1 px-3 py-1.5 text-xs text-white bg-[#12141B] border border-white/[0.08] rounded-lg focus:outline-none focus:border-rose-500"
                            />
                            <input
                              type="text"
                              disabled={isRendering}
                              value={scene.soundEffectCue ?? ''}
                              onChange={(e) =>
                                updateScene(scene.id, { soundEffectCue: e.target.value })
                              }
                              placeholder="SFX cue"
                              className="w-28 px-2.5 py-1.5 text-xs text-zinc-300 bg-[#12141B] border border-white/[0.08] rounded-lg focus:outline-none focus:border-rose-500"
                            />
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
