export const VIDEO_CATEGORIES = [
  'educational',
  'history',
  'technology',
  'science',
  'mystery',
  'storytelling',
] as const;

export type VideoCategory = (typeof VIDEO_CATEGORIES)[number];

export const CATEGORY_LABELS: Record<VideoCategory, string> = {
  educational: 'Educational',
  history: 'History',
  technology: 'Technology',
  science: 'Science',
  mystery: 'Mystery',
  storytelling: 'Storytelling',
};

export const JOB_STATUSES = [
  'draft',
  'script_ready',
  'queued',
  'processing',
  'completed',
  'failed',
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

export const VISUAL_MODES = [
  'stock_auto',
  'pexels',
  'pixabay',
  'wikimedia',
  'ai_image',
] as const;

export type VisualMode = (typeof VISUAL_MODES)[number];

export const VOICE_OPTIONS = [
  { id: 'Kore', label: 'Kore', description: 'Crisp, balanced documentary narrator' },
  { id: 'Puck', label: 'Puck', description: 'Energetic, fast-paced short-form host' },
  { id: 'Charon', label: 'Charon', description: 'Deep, authoritative investigative tone' },
  { id: 'Fenrir', label: 'Fenrir', description: 'Warm, cinematic storytelling voice' },
  { id: 'Zephyr', label: 'Zephyr', description: 'Clear, bright educational cadence' },
] as const;

export type VoiceId = (typeof VOICE_OPTIONS)[number]['id'];

export interface ScenePlanItem {
  id: string;
  sceneNumber: number;
  durationSeconds: number;
  narrationText: string;
  visualPrompt: string;
  stockKeywords: string[];
  subtitleText: string;
  transition: 'cut' | 'crossfade' | 'zoom';
  soundEffectCue?: string;
  assetSource: 'unassigned' | 'ai_image' | 'stock_video' | 'stock_image';
  providerName?: string;
  attribution?: string;
  assetLocalPath?: string;
  assetUrl?: string;
  audioLocalPath?: string;
  audioUrl?: string;
  actualAudioDurationSeconds?: number;
}

export interface VideoScript {
  title: string;
  hook: string;
  mainContent: string;
  ending: string;
  fullNarration: string;
  estimatedDurationSeconds: number;
  musicMood: string;
  researchSummary: string;
  keyFacts: string[];
  scenes: ScenePlanItem[];
}

export interface JobErrorInfo {
  code: string;
  message: string;
  retryable: boolean;
  stage: string;
  occurredAt: string;
}

export interface VideoOutputInfo {
  gcsUri?: string;
  thumbnailGcsUri?: string;
  streamUrl: string;
  downloadUrl: string;
  thumbnailUrl?: string;
  fileSizeBytes: number;
  durationSeconds: number;
  resolution: string;
  videoCodec: string;
  audioCodec: string;
  verifiedAt: string;
}

export interface AuthUserInfo {
  uid: string;
  email: string;
  displayName?: string;
  photoURL?: string;
}

export interface VideoJob {
  id: string;
  ownerUid: string;
  topic: string;
  category: VideoCategory;
  targetDurationSeconds: number;
  voiceId: string;
  visualMode: VisualMode;
  status: JobStatus;
  currentStage: string;
  progressPercent: number;
  script?: VideoScript;
  error?: JobErrorInfo;
  output?: VideoOutputInfo;
  createdAt: string;
  updatedAt: string;
  source: 'manual' | 'scheduled';
}

export interface TopicSuggestion {
  id: string;
  topic: string;
  category: VideoCategory;
  angle: string;
  hookPreview: string;
}

export interface TopicHistoryEntry {
  topic: string;
  category: VideoCategory;
  createdAt: string;
}

export interface AutomationRunLog {
  id: string;
  slotKey: string;
  triggeredAt: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped_duplicate';
  videoId?: string;
  message: string;
}

export interface AutomationConfig {
  enabled: boolean;
  videosPerDay: number;
  scheduleTimesUtc: string[];
  defaultCategory: VideoCategory | 'rotate';
  defaultDurationSeconds: number;
  defaultVoiceId: string;
  defaultVisualMode: VisualMode;
  preventDuplicatesWindowDays: number;
  lastTriggeredAt?: string;
}

export interface AppSettings {
  preferredVisualProvider: 'stock_first' | 'ai_image_first';
  resolution: '1080x1920';
  fps: 30;
  subtitleStyle: 'bold_centered' | 'minimal_bottom';
}

export interface HealthStatus {
  status: 'ok' | 'degraded';
  timestamp: string;
  backend: {
    status: 'online';
    nodeVersion: string;
    uptimeSeconds: number;
  };
  database: {
    provider: 'local_json_store' | 'firestore';
    status: 'connected' | 'unconfigured';
    note: string;
  };
  storage: {
    provider: 'gcs' | 'local_temp';
    status: 'connected' | 'unconfigured';
    bucketName?: string;
    note: string;
  };
  ffmpeg: {
    available: boolean;
    path?: string;
    version?: string;
    codecs?: string[];
    error?: string;
  };
  gemini: {
    configured: boolean;
    model: string;
  };
}

export interface DashboardSummary {
  totalVideos: number;
  completedVideos: number;
  failedJobs: number;
  processingJobs: number;
  scriptReadyCount: number;
  recentVideos: VideoJob[];
}

export interface SettingsResponse {
  settings: AppSettings;
  integrations: {
    hasGeminiKey: boolean;
    hasGcsBucket: boolean;
    gcsBucketName: string | null;
    hasPexelsKey: boolean;
    hasPixabayKey: boolean;
    hasWikimediaSupport: boolean;
    hasSchedulerSecret: boolean;
    firestoreConfigured: boolean;
  };
}
