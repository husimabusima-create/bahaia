import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getServerConfig } from '../config.ts';
import {
  deleteVideoFromFirestore,
  syncAutomationRunToFirestore,
  syncAutomationToFirestore,
  syncSettingsToFirestore,
  syncTopicHistoryToFirestore,
  syncVideoJobToFirestore,
} from './firestoreSync.ts';
import type {
  AppSettings,
  AutomationConfig,
  AutomationRunLog,
  TopicHistoryEntry,
  VideoJob,
  VideoScript,
} from '../../src/types.ts';

interface PersistedDatabase {
  videos: VideoJob[];
  topicHistoryByUser: Record<string, TopicHistoryEntry[]>;
  automationByUser: Record<string, AutomationConfig>;
  automationRunsByUser: Record<string, AutomationRunLog[]>;
  settingsByUser: Record<string, AppSettings>;
}

const DEFAULT_AUTOMATION_CONFIG: AutomationConfig = {
  enabled: false,
  videosPerDay: 2,
  scheduleTimesUtc: ['09:00', '21:00'],
  defaultCategory: 'rotate',
  defaultDurationSeconds: 45,
  defaultVoiceId: 'Kore',
  defaultVisualMode: 'stock_auto',
  preventDuplicatesWindowDays: 30,
};

const DEFAULT_SETTINGS: AppSettings = {
  preferredVisualProvider: 'stock_first',
  resolution: '1080x1920',
  fps: 30,
  subtitleStyle: 'bold_centered',
};

const DEFAULT_DB: PersistedDatabase = {
  videos: [],
  topicHistoryByUser: {},
  automationByUser: {},
  automationRunsByUser: {},
  settingsByUser: {},
};

let writeLock: Promise<void> = Promise.resolve();

function getDbFilePath(): string {
  const { dataDir } = getServerConfig();
  return path.join(dataDir, 'shortforge-db.json');
}

async function ensureDataDir(): Promise<void> {
  const { dataDir } = getServerConfig();
  await fs.mkdir(dataDir, { recursive: true });
}

async function readDb(): Promise<PersistedDatabase> {
  await ensureDataDir();
  const dbPath = getDbFilePath();
  try {
    const raw = await fs.readFile(dbPath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<PersistedDatabase>;
    return {
      videos: Array.isArray(parsed.videos)
        ? parsed.videos.map((v) => ({
            ...v,
            ownerUid: typeof v.ownerUid === 'string' ? v.ownerUid : '',
            visualMode: v.visualMode || 'stock_auto',
          }))
        : [],
      topicHistoryByUser:
        parsed.topicHistoryByUser && typeof parsed.topicHistoryByUser === 'object'
          ? parsed.topicHistoryByUser
          : {},
      automationByUser:
        parsed.automationByUser && typeof parsed.automationByUser === 'object'
          ? parsed.automationByUser
          : {},
      automationRunsByUser:
        parsed.automationRunsByUser && typeof parsed.automationRunsByUser === 'object'
          ? parsed.automationRunsByUser
          : {},
      settingsByUser:
        parsed.settingsByUser && typeof parsed.settingsByUser === 'object'
          ? parsed.settingsByUser
          : {},
    };
  } catch (err: unknown) {
    const code =
      err && typeof err === 'object' && 'code' in err ? (err as { code?: string }).code : undefined;
    if (code === 'ENOENT') {
      await writeDbAtomic(DEFAULT_DB);
      return structuredClone(DEFAULT_DB);
    }
    throw err;
  }
}

async function writeDbAtomic(db: PersistedDatabase): Promise<void> {
  await ensureDataDir();
  const dbPath = getDbFilePath();
  const tmpPath = `${dbPath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(db, null, 2), 'utf8');
  await fs.rename(tmpPath, dbPath);
}

async function mutateDb<T>(fn: (db: PersistedDatabase) => T | Promise<T>): Promise<T> {
  const previous = writeLock;
  let release!: () => void;
  writeLock = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous;
  try {
    const db = await readDb();
    const result = await fn(db);
    await writeDbAtomic(db);
    return result;
  } finally {
    release();
  }
}

export async function initStore(): Promise<void> {
  await mutateDb((db) => {
    const now = new Date().toISOString();
    for (const v of db.videos) {
      if (v.status === 'processing' || v.status === 'queued') {
        v.status = 'failed';
        v.currentStage = 'Interrupted by server restart';
        v.error = {
          code: 'SERVER_RESTARTED',
          message:
            'Server restarted while this render job was in progress. Click Retry to render again.',
          retryable: true,
          stage: v.currentStage || 'rendering',
          occurredAt: now,
        };
        v.updatedAt = now;
      }
    }
  });
}

export async function listVideos(ownerUid: string): Promise<VideoJob[]> {
  const db = await readDb();
  return db.videos
    .filter((v) => Boolean(v.ownerUid) && v.ownerUid === ownerUid)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getVideoById(id: string): Promise<VideoJob | null> {
  const db = await readDb();
  return db.videos.find((v) => v.id === id) ?? null;
}

export async function getVideoForUser(
  id: string,
  ownerUid: string
): Promise<
  | { access: 'ok'; video: VideoJob }
  | { access: 'forbidden' }
  | { access: 'not_found' }
> {
  const db = await readDb();
  const video = db.videos.find((v) => v.id === id);
  if (!video) return { access: 'not_found' };
  if (!video.ownerUid || video.ownerUid !== ownerUid) {
    return { access: 'forbidden' };
  }
  return { access: 'ok', video };
}

export async function createVideoJob(job: VideoJob, idToken?: string): Promise<VideoJob> {
  if (!job.ownerUid) {
    throw new Error('Cannot create video job without verified ownerUid.');
  }
  const created = await mutateDb((db) => {
    db.videos.unshift(job);
    const userHistory = db.topicHistoryByUser[job.ownerUid] ?? [];
    const normalized = job.topic.trim().toLowerCase();
    const alreadyExists = userHistory.some((t) => t.topic.trim().toLowerCase() === normalized);
    if (!alreadyExists) {
      userHistory.unshift({
        topic: job.topic,
        category: job.category,
        createdAt: job.createdAt,
      });
      db.topicHistoryByUser[job.ownerUid] = userHistory.slice(0, 200);
    }
    return job;
  });

  void syncVideoJobToFirestore(created, idToken);
  return created;
}

export async function updateVideoScript(
  id: string,
  ownerUid: string,
  script: VideoScript,
  idToken?: string
): Promise<VideoJob | null> {
  const updated = await mutateDb((db) => {
    const target = db.videos.find((v) => v.id === id && v.ownerUid === ownerUid);
    if (!target) return null;
    target.script = script;
    target.updatedAt = new Date().toISOString();
    return target;
  });
  if (updated) {
    void syncVideoJobToFirestore(updated, idToken);
  }
  return updated;
}

export async function updateVideoJob(
  id: string,
  patch: Partial<
    Pick<
      VideoJob,
      | 'status'
      | 'currentStage'
      | 'progressPercent'
      | 'script'
      | 'error'
      | 'output'
      | 'voiceId'
      | 'visualMode'
      | 'targetDurationSeconds'
    >
  >,
  ownerUid?: string,
  idToken?: string
): Promise<VideoJob | null> {
  const updated = await mutateDb((db) => {
    const target = db.videos.find(
      (v) => v.id === id && (ownerUid === undefined || v.ownerUid === ownerUid)
    );
    if (!target) return null;
    Object.assign(target, patch, { updatedAt: new Date().toISOString() });
    return target;
  });
  if (updated) {
    void syncVideoJobToFirestore(updated, idToken);
  }
  return updated;
}

export async function deleteVideoJob(
  id: string,
  ownerUid: string,
  idToken?: string
): Promise<'deleted' | 'forbidden' | 'not_found'> {
  const outcome = await mutateDb((db) => {
    const target = db.videos.find((v) => v.id === id);
    if (!target) return 'not_found' as const;
    if (!target.ownerUid || target.ownerUid !== ownerUid) return 'forbidden' as const;
    db.videos = db.videos.filter((v) => v.id !== id);
    return 'deleted' as const;
  });
  if (outcome === 'deleted') {
    void deleteVideoFromFirestore(ownerUid, id, idToken);
  }
  return outcome;
}

export async function getRecentTopicHistory(
  ownerUid: string,
  windowDays = 30
): Promise<TopicHistoryEntry[]> {
  const db = await readDb();
  const list = db.topicHistoryByUser[ownerUid] ?? [];
  const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  return list.filter((entry) => {
    const ts = Date.parse(entry.createdAt);
    return Number.isNaN(ts) || ts >= cutoff;
  });
}

export async function recordTopicSuggestions(
  ownerUid: string,
  entries: TopicHistoryEntry[],
  idToken?: string
): Promise<void> {
  const added: Array<{ id: string; entry: TopicHistoryEntry }> = [];
  await mutateDb((db) => {
    const list = db.topicHistoryByUser[ownerUid] ?? [];
    for (const entry of entries) {
      const normalized = entry.topic.trim().toLowerCase();
      if (!list.some((t) => t.topic.trim().toLowerCase() === normalized)) {
        list.unshift(entry);
        added.push({ id: crypto.randomUUID(), entry });
      }
    }
    db.topicHistoryByUser[ownerUid] = list.slice(0, 200);
  });

  for (const item of added) {
    void syncTopicHistoryToFirestore(ownerUid, item.id, item.entry, idToken);
  }
}

export async function getAutomationState(ownerUid: string): Promise<{
  config: AutomationConfig;
  runs: AutomationRunLog[];
}> {
  const db = await readDb();
  const config = db.automationByUser[ownerUid]
    ? { ...DEFAULT_AUTOMATION_CONFIG, ...db.automationByUser[ownerUid] }
    : structuredClone(DEFAULT_AUTOMATION_CONFIG);
  const runs = (db.automationRunsByUser[ownerUid] ?? []).slice(0, 30);
  return { config, runs };
}

export async function listEnabledAutomationUsers(): Promise<
  Array<{ ownerUid: string; config: AutomationConfig }>
> {
  const db = await readDb();
  const enabled: Array<{ ownerUid: string; config: AutomationConfig }> = [];
  for (const [ownerUid, cfg] of Object.entries(db.automationByUser)) {
    if (ownerUid && cfg?.enabled) {
      enabled.push({
        ownerUid,
        config: { ...DEFAULT_AUTOMATION_CONFIG, ...cfg },
      });
    }
  }
  return enabled;
}

export async function updateAutomationConfig(
  ownerUid: string,
  patch: Partial<AutomationConfig>,
  idToken?: string
): Promise<AutomationConfig> {
  const updated = await mutateDb((db) => {
    const current = db.automationByUser[ownerUid]
      ? { ...DEFAULT_AUTOMATION_CONFIG, ...db.automationByUser[ownerUid] }
      : structuredClone(DEFAULT_AUTOMATION_CONFIG);
    const next = { ...current, ...patch };
    db.automationByUser[ownerUid] = next;
    return next;
  });
  void syncAutomationToFirestore(ownerUid, updated, idToken);
  return updated;
}

export async function hasAutomationSlotRun(
  ownerUid: string,
  slotKey: string
): Promise<boolean> {
  const db = await readDb();
  const runs = db.automationRunsByUser[ownerUid] ?? [];
  return runs.some(
    (r) => r.slotKey === slotKey && (r.status === 'running' || r.status === 'completed')
  );
}

export async function appendAutomationRun(
  ownerUid: string,
  run: AutomationRunLog,
  idToken?: string
): Promise<void> {
  await mutateDb((db) => {
    const runs = db.automationRunsByUser[ownerUid] ?? [];
    const idx = runs.findIndex((r) => r.id === run.id);
    if (idx >= 0) {
      runs[idx] = run;
    } else {
      runs.unshift(run);
    }
    db.automationRunsByUser[ownerUid] = runs.slice(0, 100);

    if (run.status === 'completed' || run.status === 'running') {
      const current = db.automationByUser[ownerUid]
        ? { ...DEFAULT_AUTOMATION_CONFIG, ...db.automationByUser[ownerUid] }
        : structuredClone(DEFAULT_AUTOMATION_CONFIG);
      current.lastTriggeredAt = run.triggeredAt;
      db.automationByUser[ownerUid] = current;
    }
  });
  void syncAutomationRunToFirestore(ownerUid, run, idToken);
}

export async function getSettings(ownerUid: string): Promise<AppSettings> {
  const db = await readDb();
  return db.settingsByUser[ownerUid]
    ? { ...DEFAULT_SETTINGS, ...db.settingsByUser[ownerUid] }
    : structuredClone(DEFAULT_SETTINGS);
}

export async function updateSettings(
  ownerUid: string,
  patch: Partial<AppSettings>,
  idToken?: string
): Promise<AppSettings> {
  const updated = await mutateDb((db) => {
    const current = db.settingsByUser[ownerUid]
      ? { ...DEFAULT_SETTINGS, ...db.settingsByUser[ownerUid] }
      : structuredClone(DEFAULT_SETTINGS);
    const next = { ...current, ...patch };
    db.settingsByUser[ownerUid] = next;
    return next;
  });
  void syncSettingsToFirestore(ownerUid, updated, idToken);
  return updated;
}
