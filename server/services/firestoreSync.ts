import { getAdminFirestore, getFirebaseConfig } from './firebaseAdmin.ts';
import type {
  AppSettings,
  AutomationConfig,
  AutomationRunLog,
  TopicHistoryEntry,
  VideoJob,
} from '../../src/types.ts';

function toFirestoreValue(val: unknown): Record<string, unknown> {
  if (val === null || val === undefined) return { nullValue: null };
  if (typeof val === 'string') return { stringValue: val };
  if (typeof val === 'boolean') return { booleanValue: val };
  if (typeof val === 'number') {
    return Number.isInteger(val) ? { integerValue: String(val) } : { doubleValue: val };
  }
  if (Array.isArray(val)) {
    return { arrayValue: { values: val.map((item) => toFirestoreValue(item)) } };
  }
  if (typeof val === 'object') {
    const fields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val)) {
      if (v !== undefined) {
        fields[k] = toFirestoreValue(v);
      }
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(val) };
}

function toTimestampField(iso?: string): Record<string, unknown> {
  const ts = iso && !Number.isNaN(Date.parse(iso)) ? iso : new Date().toISOString();
  return { timestampValue: ts };
}

async function patchFirestoreRestDoc(params: {
  relativeDocPath: string;
  fields: Record<string, unknown>;
  idToken: string;
}): Promise<boolean> {
  const cfg = getFirebaseConfig();
  const url =
    `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(cfg.projectId)}` +
    `/databases/${encodeURIComponent(cfg.firestoreDatabaseId)}/documents/${params.relativeDocPath}`;

  try {
    const res = await fetch(url, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${params.idToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ fields: params.fields }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function deleteFirestoreRestDoc(relativeDocPath: string, idToken: string): Promise<boolean> {
  const cfg = getFirebaseConfig();
  const url =
    `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(cfg.projectId)}` +
    `/databases/${encodeURIComponent(cfg.firestoreDatabaseId)}/documents/${relativeDocPath}`;

  try {
    const res = await fetch(url, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${idToken}` },
    });
    return res.ok || res.status === 404;
  } catch {
    return false;
  }
}

export async function probeFirestoreAdminHealth(): Promise<{
  connected: boolean;
  note: string;
}> {
  try {
    const db = getAdminFirestore();
    await db.collection('_health').doc('probe').get();
    return {
      connected: true,
      note: 'Connected to Cloud Firestore via Admin SDK.',
    };
  } catch {
    return {
      connected: false,
      note: 'Firestore provisioned; using user-token Firestore sync + owner-isolated JSON store in preview.',
    };
  }
}

export async function syncVideoJobToFirestore(
  job: VideoJob,
  idToken?: string
): Promise<void> {
  const fields: Record<string, unknown> = {
    id: { stringValue: job.id },
    ownerUid: { stringValue: job.ownerUid },
    topic: { stringValue: job.topic.slice(0, 240) },
    category: { stringValue: job.category },
    targetDurationSeconds: { integerValue: String(job.targetDurationSeconds) },
    voiceId: { stringValue: job.voiceId },
    visualMode: { stringValue: job.visualMode },
    status: { stringValue: job.status },
    currentStage: { stringValue: job.currentStage.slice(0, 240) },
    progressPercent: { integerValue: String(Math.round(job.progressPercent)) },
    source: { stringValue: job.source },
    createdAt: toTimestampField(job.createdAt),
    updatedAt: toTimestampField(job.updatedAt),
  };

  if (job.script?.title) {
    fields.scriptSummary = { stringValue: job.script.title.slice(0, 2000) };
  }
  if (job.output?.resolution) {
    fields.outputSummary = {
      stringValue: `${job.output.resolution} ${job.output.durationSeconds}s`.slice(0, 1000),
    };
  }

  const relPath = `users/${job.ownerUid}/videos/${job.id}`;
  if (idToken) {
    await patchFirestoreRestDoc({ relativeDocPath: relPath, fields, idToken });
    return;
  }

  try {
    const db = getAdminFirestore();
    await db.doc(relPath).set(
      {
        id: job.id,
        ownerUid: job.ownerUid,
        topic: job.topic.slice(0, 240),
        category: job.category,
        targetDurationSeconds: job.targetDurationSeconds,
        voiceId: job.voiceId,
        visualMode: job.visualMode,
        status: job.status,
        currentStage: job.currentStage.slice(0, 240),
        progressPercent: Math.round(job.progressPercent),
        source: job.source,
        createdAt: new Date(job.createdAt),
        updatedAt: new Date(job.updatedAt),
      },
      { merge: true }
    );
  } catch {
    // Non-blocking in preview when server ADC is unattached
  }
}

export async function deleteVideoFromFirestore(
  ownerUid: string,
  videoId: string,
  idToken?: string
): Promise<void> {
  const relPath = `users/${ownerUid}/videos/${videoId}`;
  if (idToken) {
    await deleteFirestoreRestDoc(relPath, idToken);
    return;
  }
  try {
    await getAdminFirestore().doc(relPath).delete();
  } catch {
    // Non-blocking
  }
}

export async function syncSettingsToFirestore(
  ownerUid: string,
  settings: AppSettings,
  idToken?: string
): Promise<void> {
  const relPath = `users/${ownerUid}/settings/default`;
  const nowIso = new Date().toISOString();
  const fields: Record<string, unknown> = {
    ownerUid: { stringValue: ownerUid },
    preferredVisualProvider: { stringValue: settings.preferredVisualProvider },
    resolution: { stringValue: settings.resolution },
    fps: { integerValue: String(settings.fps) },
    subtitleStyle: { stringValue: settings.subtitleStyle },
    updatedAt: toTimestampField(nowIso),
  };

  if (idToken) {
    await patchFirestoreRestDoc({ relativeDocPath: relPath, fields, idToken });
    return;
  }
  try {
    await getAdminFirestore().doc(relPath).set({
      ...settings,
      ownerUid,
      updatedAt: new Date(nowIso),
    });
  } catch {
    // Non-blocking
  }
}

export async function syncAutomationToFirestore(
  ownerUid: string,
  config: AutomationConfig,
  idToken?: string
): Promise<void> {
  const relPath = `users/${ownerUid}/automation/default`;
  const nowIso = new Date().toISOString();
  const fields: Record<string, unknown> = {
    ownerUid: { stringValue: ownerUid },
    enabled: { booleanValue: config.enabled },
    videosPerDay: { integerValue: String(config.videosPerDay) },
    scheduleTimesUtc: toFirestoreValue(config.scheduleTimesUtc),
    defaultCategory: { stringValue: config.defaultCategory },
    defaultDurationSeconds: { integerValue: String(config.defaultDurationSeconds) },
    defaultVoiceId: { stringValue: config.defaultVoiceId },
    defaultVisualMode: { stringValue: config.defaultVisualMode },
    preventDuplicatesWindowDays: { integerValue: String(config.preventDuplicatesWindowDays) },
    updatedAt: toTimestampField(nowIso),
  };

  if (idToken) {
    await patchFirestoreRestDoc({ relativeDocPath: relPath, fields, idToken });
    return;
  }
  try {
    await getAdminFirestore().doc(relPath).set({
      ...config,
      ownerUid,
      updatedAt: new Date(nowIso),
    });
  } catch {
    // Non-blocking
  }
}

export async function syncAutomationRunToFirestore(
  ownerUid: string,
  run: AutomationRunLog,
  idToken?: string
): Promise<void> {
  const relPath = `users/${ownerUid}/automationRuns/${run.id}`;
  const fields: Record<string, unknown> = {
    id: { stringValue: run.id },
    ownerUid: { stringValue: ownerUid },
    slotKey: { stringValue: run.slotKey.slice(0, 64) },
    triggeredAt: toTimestampField(run.triggeredAt),
    status: { stringValue: run.status },
    message: { stringValue: run.message.slice(0, 500) },
    ...(run.videoId ? { videoId: { stringValue: run.videoId } } : {}),
  };

  if (idToken) {
    await patchFirestoreRestDoc({ relativeDocPath: relPath, fields, idToken });
    return;
  }
  try {
    await getAdminFirestore().doc(relPath).set({
      ...run,
      ownerUid,
      triggeredAt: new Date(run.triggeredAt),
    });
  } catch {
    // Non-blocking
  }
}

export async function syncTopicHistoryToFirestore(
  ownerUid: string,
  entryId: string,
  entry: TopicHistoryEntry,
  idToken?: string
): Promise<void> {
  const relPath = `users/${ownerUid}/topicHistory/${entryId}`;
  const fields: Record<string, unknown> = {
    id: { stringValue: entryId },
    ownerUid: { stringValue: ownerUid },
    topic: { stringValue: entry.topic.slice(0, 240) },
    category: { stringValue: entry.category },
    createdAt: toTimestampField(entry.createdAt),
  };

  if (idToken) {
    await patchFirestoreRestDoc({ relativeDocPath: relPath, fields, idToken });
    return;
  }
  try {
    await getAdminFirestore().doc(relPath).set({
      id: entryId,
      ownerUid,
      topic: entry.topic.slice(0, 240),
      category: entry.category,
      createdAt: new Date(entry.createdAt),
    });
  } catch {
    // Non-blocking
  }
}
