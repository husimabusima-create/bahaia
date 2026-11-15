import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import { getServerConfig } from '../config.ts';
import { optionalAuth, requireAuth } from '../middleware/auth.ts';
import {
  aiGenerationLimiter,
  apiGeneralLimiter,
  authSessionLimiter,
  renderPipelineLimiter,
} from '../middleware/rateLimit.ts';
import { probeFfmpeg } from '../services/ffmpeg.ts';
import {
  createSignedSessionToken,
  SESSION_COOKIE_NAME,
  verifyFirebaseIdToken,
} from '../services/firebaseAdmin.ts';
import { probeFirestoreAdminHealth } from '../services/firestoreSync.ts';
import {
  GEMINI_TEXT_MODEL,
  GeminiServiceError,
  generateResearchAndScript,
  generateTopicSuggestions,
} from '../services/gemini.ts';
import { executeFullRenderPipeline, isJobRendering } from '../services/pipeline.ts';
import {
  checkStorageHealth,
  deleteJobArtifacts,
  getFinalMp4Path,
  getJobWorkDir,
  getThumbnailPath,
  openGcsReadStream,
} from '../services/storage.ts';
import {
  appendAutomationRun,
  createVideoJob,
  deleteVideoJob,
  getAutomationState,
  getRecentTopicHistory,
  getSettings,
  getVideoForUser,
  hasAutomationSlotRun,
  listEnabledAutomationUsers,
  listVideos,
  recordTopicSuggestions,
  updateAutomationConfig,
  updateSettings,
  updateVideoJob,
  updateVideoScript,
} from '../services/store.ts';
import {
  VIDEO_CATEGORIES,
  VISUAL_MODES,
  VOICE_OPTIONS,
  type DashboardSummary,
  type HealthStatus,
  type VideoCategory,
  type VideoJob,
  type VideoScript,
  type VisualMode,
} from '../../src/types.ts';

const VALID_ID_REGEX = /^[a-zA-Z0-9_-]{1,128}$/;

function isValidResourceId(val: unknown): val is string {
  return typeof val === 'string' && VALID_ID_REGEX.test(val);
}

function isValidCategory(val: unknown): val is VideoCategory {
  return typeof val === 'string' && (VIDEO_CATEGORIES as readonly string[]).includes(val);
}

function isValidVisualMode(val: unknown): val is VisualMode {
  return typeof val === 'string' && (VISUAL_MODES as readonly string[]).includes(val);
}

function isValidVoiceId(val: unknown): val is string {
  return typeof val === 'string' && VOICE_OPTIONS.some((v) => v.id === val.trim());
}

function sanitizeDownloadFilename(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${slug || 'shortforge-video'}.mp4`;
}

function timingSafeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function isHttpsRequest(req: express.Request): boolean {
  const proto = req.header('x-forwarded-proto') || '';
  return req.secure || proto.split(',')[0]?.trim().toLowerCase() === 'https';
}

function validationError(res: express.Response, message: string, code = 'VALIDATION_ERROR') {
  res.status(400).json({
    error: {
      code,
      message,
      retryable: false,
    },
  });
}

async function resolveAuthorizedVideo(
  req: express.Request,
  res: express.Response,
  videoId: string
): Promise<VideoJob | null> {
  if (!isValidResourceId(videoId)) {
    validationError(res, 'Invalid video identifier.', 'INVALID_ID');
    return null;
  }
  const uid = req.authUser!.uid;
  const result = await getVideoForUser(videoId, uid);
  if (result.access === 'not_found') {
    res.status(404).json({
      error: { code: 'NOT_FOUND', message: 'Video record not found.', retryable: false },
    });
    return null;
  }
  if (result.access === 'forbidden') {
    res.status(403).json({
      error: {
        code: 'FORBIDDEN_RESOURCE_ACCESS',
        message: 'You do not have permission to access this video.',
        retryable: false,
      },
    });
    return null;
  }
  return result.video;
}

export function createApiRouter(): express.Router {
  const router = express.Router();

  // Base rate limiter across all API endpoints (excluding health check below)
  router.use((req, res, next) => {
    if (req.path === '/health') {
      next();
      return;
    }
    apiGeneralLimiter(req, res, next);
  });

  // ---------------------------------------------------------------------------
  // Authentication & Session Routes (Firebase ID Token -> HttpOnly Cookie)
  // ---------------------------------------------------------------------------
  router.post('/auth/session', authSessionLimiter, async (req, res) => {
    try {
      const authHeader = req.header('authorization') || '';
      const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
      const bodyToken = typeof req.body?.idToken === 'string' ? req.body.idToken.trim() : '';
      const idToken = bearerToken || bodyToken;

      if (!idToken || idToken.length > 8192) {
        res.status(401).json({
          error: {
            code: 'MISSING_ID_TOKEN',
            message: 'A valid Firebase ID token is required.',
            retryable: false,
          },
        });
        return;
      }

      const user = await verifyFirebaseIdToken(idToken);
      if (user.email && !user.emailVerified) {
        res.status(403).json({
          error: {
            code: 'EMAIL_NOT_VERIFIED',
            message: 'Verified email authentication is required.',
            retryable: false,
          },
        });
        return;
      }

      const sessionToken = createSignedSessionToken(user);
      const secure = isHttpsRequest(req);

      res.cookie(SESSION_COOKIE_NAME, sessionToken, {
        httpOnly: true,
        secure,
        sameSite: secure ? 'none' : 'lax',
        path: '/',
        maxAge: 55 * 60 * 1000,
      });

      res.json({
        authenticated: true,
        user: {
          uid: user.uid,
          email: user.email,
          displayName: user.displayName,
        },
      });
    } catch {
      res.status(401).json({
        error: {
          code: 'INVALID_ID_TOKEN',
          message: 'Firebase ID token verification failed.',
          retryable: false,
        },
      });
    }
  });

  router.post('/auth/logout', (req, res) => {
    const secure = isHttpsRequest(req);
    res.clearCookie(SESSION_COOKIE_NAME, {
      httpOnly: true,
      secure,
      sameSite: secure ? 'none' : 'lax',
      path: '/',
    });
    res.json({ signedOut: true });
  });

  router.get('/auth/me', requireAuth, (req, res) => {
    res.json({
      authenticated: true,
      user: {
        uid: req.authUser!.uid,
        email: req.authUser!.email,
        displayName: req.authUser!.displayName,
      },
    });
  });

  // ---------------------------------------------------------------------------
  // Health Check (minimal when unauthenticated; full diagnostics when authenticated)
  // ---------------------------------------------------------------------------
  router.get('/health', optionalAuth, async (req, res) => {
    const config = getServerConfig();
    const ffmpeg = await probeFfmpeg(false);
    const geminiConfigured = Boolean(
      config.geminiApiKey && config.geminiApiKey !== 'MY_GEMINI_API_KEY'
    );
    const status: HealthStatus['status'] =
      ffmpeg.available && geminiConfigured ? 'ok' : 'degraded';

    if (!req.authUser) {
      res.json({
        status,
        timestamp: new Date().toISOString(),
        authRequired: true,
      });
      return;
    }

    const [storage, firestoreProbe] = await Promise.all([
      checkStorageHealth(),
      probeFirestoreAdminHealth(),
    ]);

    const payload: HealthStatus = {
      status,
      timestamp: new Date().toISOString(),
      backend: {
        status: 'online',
        nodeVersion: process.version,
        uptimeSeconds: Math.round(process.uptime()),
      },
      database: {
        provider: firestoreProbe.connected ? 'firestore' : 'local_json_store',
        status: 'connected',
        note: firestoreProbe.note,
      },
      storage,
      ffmpeg: {
        available: ffmpeg.available,
        path: ffmpeg.path,
        version: ffmpeg.version,
        codecs: ffmpeg.codecs,
        error: ffmpeg.error,
      },
      gemini: {
        configured: geminiConfigured,
        model: GEMINI_TEXT_MODEL,
      },
    };

    res.json(payload);
  });

  // ---------------------------------------------------------------------------
  // Server-to-Server Cloud Scheduler Webhook (Protected strictly by SCHEDULER_SECRET)
  // ---------------------------------------------------------------------------
  router.post('/automation/trigger', async (req, res) => {
    const serverConfig = getServerConfig();
    if (!serverConfig.schedulerSecret) {
      res.status(503).json({
        error: {
          code: 'SCHEDULER_SECRET_UNCONFIGURED',
          message: 'SCHEDULER_SECRET is not configured on the server.',
          retryable: false,
        },
      });
      return;
    }

    const incomingSecret = req.header('x-scheduler-secret') || '';
    if (!incomingSecret || !timingSafeEquals(incomingSecret, serverConfig.schedulerSecret)) {
      res.status(401).json({
        error: {
          code: 'UNAUTHORIZED_SCHEDULER',
          message: 'Missing or invalid X-Scheduler-Secret header.',
          retryable: false,
        },
      });
      return;
    }

    const requestedUid =
      typeof req.body?.ownerUid === 'string' && isValidResourceId(req.body.ownerUid)
        ? req.body.ownerUid.trim()
        : '';

    const targets = requestedUid
      ? [{ ownerUid: requestedUid, ...(await getAutomationState(requestedUid)) }]
      : (await listEnabledAutomationUsers()).map((u) => ({
          ownerUid: u.ownerUid,
          config: u.config,
        }));

    const enabledTargets = targets.filter((t) => t.config.enabled);
    if (enabledTargets.length === 0) {
      res.status(200).json({
        skipped: true,
        reason: 'No users have scheduled automation enabled.',
      });
      return;
    }

    const now = new Date();
    const dateKey = now.toISOString().slice(0, 10);
    const slotLabel =
      typeof req.body?.slot === 'string' && /^[a-zA-Z0-9_-]{3,64}$/.test(req.body.slot.trim())
        ? req.body.slot.trim()
        : `${dateKey}-${now.getUTCHours() < 12 ? 'am' : 'pm'}`;

    const results: Array<{ ownerUid: string; status: string; videoId?: string; message: string }> =
      [];

    for (const target of enabledTargets) {
      const uid = target.ownerUid;
      const cfg = target.config;

      if (await hasAutomationSlotRun(uid, slotLabel)) {
        await appendAutomationRun(uid, {
          id: crypto.randomUUID(),
          slotKey: slotLabel,
          triggeredAt: now.toISOString(),
          status: 'skipped_duplicate',
          message: `Prevented duplicate scheduled job for slot ${slotLabel}.`,
        });
        results.push({
          ownerUid: uid,
          status: 'skipped_duplicate',
          message: `Duplicate run prevented for slot ${slotLabel}.`,
        });
        continue;
      }

      const runId = crypto.randomUUID();
      await appendAutomationRun(uid, {
        id: runId,
        slotKey: slotLabel,
        triggeredAt: now.toISOString(),
        status: 'running',
        message: 'Running scheduled video generation pipeline...',
      });

      try {
        const categoryIndex =
          (now.getUTCDate() + (now.getUTCHours() >= 12 ? 1 : 0)) % VIDEO_CATEGORIES.length;
        const category: VideoCategory =
          cfg.defaultCategory === 'rotate'
            ? VIDEO_CATEGORIES[categoryIndex]
            : cfg.defaultCategory;

        const history = await getRecentTopicHistory(uid, cfg.preventDuplicatesWindowDays);
        const suggestions = await generateTopicSuggestions({
          category,
          recentTopics: history.map((h) => h.topic),
          count: 1,
        });

        const chosen = suggestions[0];
        if (!chosen) {
          throw new Error('Gemini returned no topic suggestions.');
        }

        const script = await generateResearchAndScript({
          topic: chosen.topic,
          category,
          targetDurationSeconds: cfg.defaultDurationSeconds,
        });

        const job: VideoJob = {
          id: crypto.randomUUID(),
          ownerUid: uid,
          topic: chosen.topic,
          category,
          targetDurationSeconds: cfg.defaultDurationSeconds,
          voiceId: cfg.defaultVoiceId,
          visualMode: cfg.defaultVisualMode || 'stock_auto',
          status: 'processing',
          currentStage: 'Starting automated MP4 render',
          progressPercent: 48,
          script,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
          source: 'scheduled',
        };

        await createVideoJob(job);
        const completedJob = await executeFullRenderPipeline(job.id);

        const message = `Produced verified ${completedJob.output?.resolution} MP4 (${completedJob.output?.durationSeconds}s): "${completedJob.script?.title}".`;
        await appendAutomationRun(uid, {
          id: runId,
          slotKey: slotLabel,
          triggeredAt: now.toISOString(),
          status: 'completed',
          videoId: completedJob.id,
          message,
        });
        results.push({ ownerUid: uid, status: 'completed', videoId: completedJob.id, message });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Scheduled job failed';
        await appendAutomationRun(uid, {
          id: runId,
          slotKey: slotLabel,
          triggeredAt: now.toISOString(),
          status: 'failed',
          message,
        });
        results.push({ ownerUid: uid, status: 'failed', message });
      }
    }

    res.status(200).json({ slot: slotLabel, results });
  });

  // ===========================================================================
  // ALL ROUTES BELOW REQUIRE AUTHENTICATED USER SESSION (requireAuth -> HTTP 401)
  // ===========================================================================
  router.use(requireAuth);

  // Dashboard metrics (scoped strictly to req.authUser.uid)
  router.get('/dashboard', async (req, res, next) => {
    try {
      const videos = await listVideos(req.authUser!.uid);
      const summary: DashboardSummary = {
        totalVideos: videos.length,
        completedVideos: videos.filter((v) => v.status === 'completed').length,
        failedJobs: videos.filter((v) => v.status === 'failed').length,
        processingJobs: videos.filter(
          (v) => v.status === 'processing' || v.status === 'queued'
        ).length,
        scriptReadyCount: videos.filter((v) => v.status === 'script_ready').length,
        recentVideos: videos.slice(0, 8),
      };
      res.json(summary);
    } catch (err) {
      next(err);
    }
  });

  // Topic suggestions (deduplicated against user's recent history)
  router.post('/topics/suggest', aiGenerationLimiter, async (req, res) => {
    try {
      if (req.body?.category !== undefined && !isValidCategory(req.body.category)) {
        validationError(res, 'Invalid video category.');
        return;
      }
      const category: VideoCategory = isValidCategory(req.body?.category)
        ? req.body.category
        : 'educational';

      const uid = req.authUser!.uid;
      const { config } = await getAutomationState(uid);
      const history = await getRecentTopicHistory(uid, config.preventDuplicatesWindowDays);
      const recentTopics = history.map((h) => h.topic);

      const suggestions = await generateTopicSuggestions({
        category,
        recentTopics,
        count: 4,
      });

      await recordTopicSuggestions(
        uid,
        suggestions.map((s) => ({
          topic: s.topic,
          category: s.category,
          createdAt: new Date().toISOString(),
        })),
        req.authUser!.idToken
      );

      res.json({ suggestions });
    } catch (err) {
      if (err instanceof GeminiServiceError) {
        res.status(err.statusCode).json({
          error: {
            code: err.code,
            message: err.message,
            retryable: err.retryable,
          },
        });
        return;
      }
      res.status(500).json({
        error: {
          code: 'TOPIC_SUGGESTION_FAILED',
          message: 'Failed to generate topic suggestions.',
          retryable: true,
        },
      });
    }
  });

  router.get('/topics/history', async (req, res, next) => {
    try {
      const history = await getRecentTopicHistory(req.authUser!.uid, 30);
      res.json({ history });
    } catch (err) {
      next(err);
    }
  });

  // Research + Script + Scene Plan generation
  router.post('/scripts/generate', aiGenerationLimiter, async (req, res) => {
    try {
      const rawTopic = typeof req.body?.topic === 'string' ? req.body.topic.trim() : '';
      if (!rawTopic || rawTopic.length < 3 || rawTopic.length > 240) {
        validationError(
          res,
          'Please provide a topic between 3 and 240 characters.',
          'INVALID_TOPIC'
        );
        return;
      }
      if (req.body?.category !== undefined && !isValidCategory(req.body.category)) {
        validationError(res, 'Invalid category selection.');
        return;
      }
      if (req.body?.voiceId !== undefined && !isValidVoiceId(req.body.voiceId)) {
        validationError(res, 'Invalid narration voice selection.');
        return;
      }
      if (req.body?.visualMode !== undefined && !isValidVisualMode(req.body.visualMode)) {
        validationError(res, 'Invalid visual media mode.');
        return;
      }

      const category: VideoCategory = isValidCategory(req.body?.category)
        ? req.body.category
        : 'educational';
      const parsedDuration = Number(req.body?.targetDurationSeconds ?? 45);
      if (!Number.isFinite(parsedDuration) || parsedDuration < 20 || parsedDuration > 90) {
        validationError(res, 'targetDurationSeconds must be between 20 and 90.');
        return;
      }
      const targetDurationSeconds = Math.round(parsedDuration);
      const voiceId = isValidVoiceId(req.body?.voiceId) ? req.body.voiceId.trim() : 'Kore';
      const visualMode = isValidVisualMode(req.body?.visualMode)
        ? req.body.visualMode
        : 'stock_auto';

      const script = await generateResearchAndScript({
        topic: rawTopic,
        category,
        targetDurationSeconds,
      });

      const now = new Date().toISOString();
      const job: VideoJob = {
        id: crypto.randomUUID(),
        ownerUid: req.authUser!.uid,
        topic: rawTopic,
        category,
        targetDurationSeconds,
        voiceId,
        visualMode,
        status: 'script_ready',
        currentStage: 'Script & Scene Plan ready',
        progressPercent: 45,
        script,
        createdAt: now,
        updatedAt: now,
        source: 'manual',
      };

      await createVideoJob(job, req.authUser!.idToken);
      res.status(201).json({ video: job });
    } catch (err) {
      if (err instanceof GeminiServiceError) {
        res.status(err.statusCode).json({
          error: {
            code: err.code,
            message: err.message,
            retryable: err.retryable,
          },
        });
        return;
      }
      res.status(500).json({
        error: {
          code: 'SCRIPT_GENERATION_FAILED',
          message: 'Failed to generate script.',
          retryable: true,
        },
      });
    }
  });

  // Video records CRUD (strictly user-scoped)
  router.get('/videos', async (req, res, next) => {
    try {
      let videos = await listVideos(req.authUser!.uid);
      const statusFilter = typeof req.query.status === 'string' ? req.query.status : '';
      const categoryFilter = typeof req.query.category === 'string' ? req.query.category : '';

      if (statusFilter && statusFilter !== 'all') {
        videos = videos.filter((v) => v.status === statusFilter);
      }
      if (categoryFilter && categoryFilter !== 'all') {
        videos = videos.filter((v) => v.category === categoryFilter);
      }

      res.json({ videos });
    } catch (err) {
      next(err);
    }
  });

  router.get('/videos/:id', async (req, res, next) => {
    try {
      const video = await resolveAuthorizedVideo(req, res, req.params.id);
      if (!video) return;
      res.json({ video });
    } catch (err) {
      next(err);
    }
  });

  router.patch('/videos/:id/script', async (req, res, next) => {
    try {
      const existing = await resolveAuthorizedVideo(req, res, req.params.id);
      if (!existing) return;

      if (isJobRendering(existing.id)) {
        res.status(409).json({
          error: {
            code: 'JOB_ACTIVE',
            message: 'Cannot edit script while rendering is in progress.',
            retryable: false,
          },
        });
        return;
      }

      const incomingScript = req.body?.script as VideoScript | undefined;
      if (
        !incomingScript ||
        !Array.isArray(incomingScript.scenes) ||
        incomingScript.scenes.length === 0 ||
        incomingScript.scenes.length > 15
      ) {
        validationError(
          res,
          'Valid script with 1 to 15 scenes is required.',
          'INVALID_SCRIPT'
        );
        return;
      }

      if (req.body?.voiceId !== undefined && !isValidVoiceId(req.body.voiceId)) {
        validationError(res, 'Invalid voiceId selection.');
        return;
      }
      if (req.body?.visualMode !== undefined && !isValidVisualMode(req.body.visualMode)) {
        validationError(res, 'Invalid visualMode selection.');
        return;
      }

      const nextVoiceId = isValidVoiceId(req.body?.voiceId)
        ? req.body.voiceId.trim()
        : existing.voiceId;
      const voiceChanged = nextVoiceId !== existing.voiceId;

      if (isValidVisualMode(req.body?.visualMode) || voiceChanged) {
        await updateVideoJob(
          existing.id,
          {
            ...(isValidVisualMode(req.body?.visualMode)
              ? { visualMode: req.body.visualMode }
              : {}),
            ...(voiceChanged ? { voiceId: nextVoiceId } : {}),
          },
          req.authUser!.uid,
          req.authUser!.idToken
        );
      }

      const prevScenesById = new Map((existing.script?.scenes ?? []).map((s) => [s.id, s]));

      const normalizedScenes = incomingScript.scenes.map((scene, index) => {
        const prev = prevScenesById.get(scene.id);
        const cleanNarration = String(scene.narrationText || '').trim().slice(0, 1000);
        const textChanged = !prev || prev.narrationText.trim() !== cleanNarration;
        const clearAudio = voiceChanged || textChanged;
        const transition: 'cut' | 'crossfade' | 'zoom' =
          scene.transition === 'crossfade' || scene.transition === 'zoom'
            ? scene.transition
            : 'cut';

        return {
          ...scene,
          id: isValidResourceId(scene.id) ? scene.id : crypto.randomUUID(),
          sceneNumber: index + 1,
          durationSeconds: Math.min(30, Math.max(1, Number(scene.durationSeconds) || 4)),
          narrationText: cleanNarration,
          subtitleText: String(scene.subtitleText || '').trim().slice(0, 300),
          visualPrompt: String(scene.visualPrompt || '').trim().slice(0, 1000),
          stockKeywords: Array.isArray(scene.stockKeywords)
            ? scene.stockKeywords
                .map((k) => String(k).trim().slice(0, 80))
                .filter(Boolean)
                .slice(0, 6)
            : [],
          transition,
          soundEffectCue: scene.soundEffectCue
            ? String(scene.soundEffectCue).trim().slice(0, 100)
            : undefined,
          ...(clearAudio
            ? {
                audioLocalPath: undefined,
                audioUrl: undefined,
                actualAudioDurationSeconds: undefined,
              }
            : {}),
        };
      });

      const estimatedDurationSeconds = Math.round(
        normalizedScenes.reduce((sum, s) => sum + s.durationSeconds, 0)
      );
      const fullNarration = normalizedScenes
        .map((s) => s.narrationText)
        .filter(Boolean)
        .join(' ');

      const updated = await updateVideoScript(
        existing.id,
        req.authUser!.uid,
        {
          ...incomingScript,
          title: String(incomingScript.title || existing.topic).trim().slice(0, 240),
          scenes: normalizedScenes,
          estimatedDurationSeconds,
          fullNarration: fullNarration || String(incomingScript.fullNarration || '').slice(0, 6000),
        },
        req.authUser!.idToken
      );

      res.json({ video: updated });
    } catch (err) {
      next(err);
    }
  });

  router.delete('/videos/:id', async (req, res, next) => {
    try {
      if (!isValidResourceId(req.params.id)) {
        validationError(res, 'Invalid video identifier.', 'INVALID_ID');
        return;
      }
      if (isJobRendering(req.params.id)) {
        res.status(409).json({
          error: {
            code: 'JOB_ACTIVE',
            message: 'Cannot delete a video job while FFmpeg rendering is actively running.',
          },
        });
        return;
      }
      const outcome = await deleteVideoJob(
        req.params.id,
        req.authUser!.uid,
        req.authUser!.idToken
      );
      if (outcome === 'not_found') {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Video record not found.' } });
        return;
      }
      if (outcome === 'forbidden') {
        res.status(403).json({
          error: {
            code: 'FORBIDDEN_RESOURCE_ACCESS',
            message: 'You do not have permission to delete this video.',
          },
        });
        return;
      }
      await deleteJobArtifacts(req.params.id);
      res.json({ deleted: true });
    } catch (err) {
      next(err);
    }
  });

  // Trigger MP4 Render (user-authenticated + render rate limiter)
  router.post('/videos/:id/render', renderPipelineLimiter, async (req, res, next) => {
    try {
      const video = await resolveAuthorizedVideo(req, res, req.params.id);
      if (!video) return;

      if (!video.script || video.script.scenes.length === 0) {
        res.status(400).json({
          error: {
            code: 'SCRIPT_REQUIRED',
            message: 'Generate a script and scene plan before rendering.',
            retryable: false,
          },
        });
        return;
      }

      if (req.body?.voiceId !== undefined && !isValidVoiceId(req.body.voiceId)) {
        validationError(res, 'Invalid voiceId selection.');
        return;
      }
      if (req.body?.visualMode !== undefined && !isValidVisualMode(req.body.visualMode)) {
        validationError(res, 'Invalid visualMode selection.');
        return;
      }

      const ffmpeg = await probeFfmpeg(false);
      if (!ffmpeg.available) {
        res.status(503).json({
          error: {
            code: 'FFMPEG_UNAVAILABLE',
            message: 'FFmpeg is not installed or unavailable on the server.',
            retryable: false,
          },
        });
        return;
      }

      if (isJobRendering(video.id)) {
        res.status(202).json({ video });
        return;
      }

      const voiceId = isValidVoiceId(req.body?.voiceId)
        ? req.body.voiceId.trim()
        : video.voiceId;
      const voiceChanged = voiceId !== video.voiceId;
      const visualMode = isValidVisualMode(req.body?.visualMode)
        ? req.body.visualMode
        : video.visualMode || 'stock_auto';

      const invalidatedScenes = voiceChanged
        ? video.script.scenes.map((s) => ({
            ...s,
            audioLocalPath: undefined,
            audioUrl: undefined,
            actualAudioDurationSeconds: undefined,
          }))
        : video.script.scenes;

      const queued = await updateVideoJob(
        video.id,
        {
          voiceId,
          visualMode,
          ...(voiceChanged ? { script: { ...video.script, scenes: invalidatedScenes } } : {}),
          status: 'processing',
          currentStage: 'Starting production pipeline',
          progressPercent: 50,
          error: undefined,
        },
        req.authUser!.uid,
        req.authUser!.idToken
      );

      void executeFullRenderPipeline(video.id).catch((err) => {
        console.error(`[Pipeline] Video ${video.id} failed:`, err);
      });

      res.status(202).json({ video: queued });
    } catch (err) {
      next(err);
    }
  });

  // Stream MP4 (owner-only)
  router.get('/videos/:id/stream', async (req, res, next) => {
    try {
      const video = await resolveAuthorizedVideo(req, res, req.params.id);
      if (!video) return;

      const localMp4 = getFinalMp4Path(video.id);
      try {
        const stat = await fsp.stat(localMp4);
        const total = stat.size;
        const range = req.headers.range;

        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Cache-Control', 'private, no-store');

        if (range) {
          const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
          const start = match && match[1] ? Number(match[1]) : 0;
          const rawEnd = match && match[2] ? Number(match[2]) : total - 1;
          const end = Math.min(rawEnd, total - 1);
          if (
            !Number.isFinite(start) ||
            !Number.isFinite(end) ||
            start < 0 ||
            start >= total ||
            end < start
          ) {
            res.status(416).setHeader('Content-Range', `bytes */${total}`).end();
            return;
          }
          const chunksize = end - start + 1;
          res.status(206);
          res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
          res.setHeader('Content-Length', chunksize);
          fs.createReadStream(localMp4, { start, end })
            .on('error', (streamErr) => next(streamErr))
            .pipe(res);
          return;
        }

        res.setHeader('Content-Length', total);
        fs.createReadStream(localMp4)
          .on('error', (streamErr) => next(streamErr))
          .pipe(res);
        return;
      } catch {
        const gcsStream = await openGcsReadStream(`videos/${video.id}/final.mp4`);
        if (!gcsStream) {
          res.status(404).json({
            error: { code: 'MP4_NOT_FOUND', message: 'MP4 file not rendered yet.' },
          });
          return;
        }
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Cache-Control', 'private, no-store');
        if (gcsStream.size > 0) {
          res.setHeader('Content-Length', gcsStream.size);
        }
        gcsStream.file
          .createReadStream()
          .on('error', (streamErr) => next(streamErr))
          .pipe(res);
      }
    } catch (err) {
      next(err);
    }
  });

  // Download MP4 attachment (owner-only)
  router.get('/videos/:id/download', async (req, res, next) => {
    try {
      const video = await resolveAuthorizedVideo(req, res, req.params.id);
      if (!video) return;

      const filename = sanitizeDownloadFilename(video.script?.title || video.topic);
      const localMp4 = getFinalMp4Path(video.id);
      res.setHeader('Cache-Control', 'private, no-store');

      try {
        await fsp.access(localMp4);
        res.download(localMp4, filename);
        return;
      } catch {
        const gcsStream = await openGcsReadStream(`videos/${video.id}/final.mp4`);
        if (!gcsStream) {
          res.status(404).json({
            error: { code: 'MP4_NOT_FOUND', message: 'MP4 file not rendered yet.' },
          });
          return;
        }
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        gcsStream.file
          .createReadStream()
          .on('error', (streamErr) => next(streamErr))
          .pipe(res);
      }
    } catch (err) {
      next(err);
    }
  });

  // Serve rendered video thumbnail JPEG (owner-only)
  router.get('/videos/:id/thumbnail', async (req, res, next) => {
    try {
      const video = await resolveAuthorizedVideo(req, res, req.params.id);
      if (!video) return;

      const localThumb = getThumbnailPath(video.id);
      res.setHeader('Cache-Control', 'private, no-store');

      try {
        await fsp.access(localThumb);
        res.setHeader('Content-Type', 'image/jpeg');
        fs.createReadStream(localThumb)
          .on('error', (streamErr) => next(streamErr))
          .pipe(res);
        return;
      } catch {
        const gcsStream = await openGcsReadStream(`videos/${video.id}/thumbnail.jpg`);
        if (!gcsStream) {
          res.status(404).end();
          return;
        }
        res.setHeader('Content-Type', 'image/jpeg');
        gcsStream.file
          .createReadStream()
          .on('error', (streamErr) => next(streamErr))
          .pipe(res);
      }
    } catch (err) {
      next(err);
    }
  });

  // Serve per-scene generated audio/visual media safely (owner-only)
  router.get('/media/:videoId/:filename', async (req, res, next) => {
    try {
      const video = await resolveAuthorizedVideo(req, res, req.params.videoId);
      if (!video) return;

      const safeFile = path.basename(req.params.filename);
      if (!/^[a-zA-Z0-9._-]{3,128}$/.test(safeFile)) {
        res.status(400).json({ error: { code: 'INVALID_FILENAME', message: 'Invalid filename.' } });
        return;
      }

      const workDir = getJobWorkDir(video.id);
      const fullPath = path.join(workDir, safeFile);

      try {
        await fsp.access(fullPath);
      } catch {
        res.status(404).end();
        return;
      }

      if (safeFile.endsWith('.wav')) res.setHeader('Content-Type', 'audio/wav');
      else if (safeFile.endsWith('.mp4')) res.setHeader('Content-Type', 'video/mp4');
      else if (safeFile.endsWith('.png')) res.setHeader('Content-Type', 'image/png');
      else if (safeFile.endsWith('.jpg') || safeFile.endsWith('.jpeg')) {
        res.setHeader('Content-Type', 'image/jpeg');
      }

      res.setHeader('Cache-Control', 'private, no-store');
      fs.createReadStream(fullPath)
        .on('error', (streamErr) => next(streamErr))
        .pipe(res);
    } catch (err) {
      next(err);
    }
  });

  // ---------------------------------------------------------------------------
  // User Automation Configuration & Authenticated Manual Trigger
  // ---------------------------------------------------------------------------
  router.get('/automation', async (req, res, next) => {
    try {
      const state = await getAutomationState(req.authUser!.uid);
      res.json(state);
    } catch (err) {
      next(err);
    }
  });

  router.patch('/automation', async (req, res, next) => {
    try {
      const patch = req.body;
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        validationError(res, 'Request body must be a JSON object.');
        return;
      }

      const allowedKeys = new Set([
        'enabled',
        'videosPerDay',
        'scheduleTimesUtc',
        'defaultCategory',
        'defaultDurationSeconds',
        'defaultVoiceId',
        'defaultVisualMode',
        'preventDuplicatesWindowDays',
        'lastTriggeredAt',
      ]);
      for (const key of Object.keys(patch)) {
        if (!allowedKeys.has(key)) {
          validationError(res, `Unsupported automation field "${key}".`);
          return;
        }
      }

      if (patch.enabled !== undefined && typeof patch.enabled !== 'boolean') {
        validationError(res, 'enabled must be a boolean.');
        return;
      }
      if (
        patch.videosPerDay !== undefined &&
        (typeof patch.videosPerDay !== 'number' ||
          patch.videosPerDay < 1 ||
          patch.videosPerDay > 4)
      ) {
        validationError(res, 'videosPerDay must be a number between 1 and 4.');
        return;
      }
      if (
        patch.defaultCategory !== undefined &&
        patch.defaultCategory !== 'rotate' &&
        !isValidCategory(patch.defaultCategory)
      ) {
        validationError(res, 'Invalid defaultCategory.');
        return;
      }
      if (
        patch.defaultDurationSeconds !== undefined &&
        (typeof patch.defaultDurationSeconds !== 'number' ||
          patch.defaultDurationSeconds < 20 ||
          patch.defaultDurationSeconds > 90)
      ) {
        validationError(res, 'defaultDurationSeconds must be between 20 and 90.');
        return;
      }
      if (patch.defaultVoiceId !== undefined && !isValidVoiceId(patch.defaultVoiceId)) {
        validationError(res, 'Invalid defaultVoiceId.');
        return;
      }
      if (patch.defaultVisualMode !== undefined && !isValidVisualMode(patch.defaultVisualMode)) {
        validationError(res, 'Invalid defaultVisualMode.');
        return;
      }

      const uid = req.authUser!.uid;
      const updated = await updateAutomationConfig(
        uid,
        {
          ...(typeof patch.enabled === 'boolean' ? { enabled: patch.enabled } : {}),
          ...(typeof patch.videosPerDay === 'number'
            ? { videosPerDay: Math.round(patch.videosPerDay) }
            : {}),
          ...(Array.isArray(patch.scheduleTimesUtc)
            ? {
                scheduleTimesUtc: patch.scheduleTimesUtc
                  .slice(0, 6)
                  .map((t: unknown) => String(t).trim())
                  .filter((t: string) => /^\d{2}:\d{2}$/.test(t)),
              }
            : {}),
          ...(patch.defaultCategory === 'rotate' || isValidCategory(patch.defaultCategory)
            ? { defaultCategory: patch.defaultCategory }
            : {}),
          ...(typeof patch.defaultDurationSeconds === 'number'
            ? { defaultDurationSeconds: Math.round(patch.defaultDurationSeconds) }
            : {}),
          ...(isValidVoiceId(patch.defaultVoiceId)
            ? { defaultVoiceId: patch.defaultVoiceId.trim() }
            : {}),
          ...(isValidVisualMode(patch.defaultVisualMode)
            ? { defaultVisualMode: patch.defaultVisualMode }
            : {}),
          ...(typeof patch.preventDuplicatesWindowDays === 'number'
            ? {
                preventDuplicatesWindowDays: Math.max(
                  1,
                  Math.min(365, Math.round(patch.preventDuplicatesWindowDays))
                ),
              }
            : {}),
        },
        req.authUser!.idToken
      );

      const state = await getAutomationState(uid);
      res.json({ config: updated, runs: state.runs });
    } catch (err) {
      next(err);
    }
  });

  // Manual Automation Trigger protected exclusively by authenticated user session (never SCHEDULER_SECRET)
  router.post('/automation/run-manual', renderPipelineLimiter, async (req, res) => {
    const uid = req.authUser!.uid;
    const { config } = await getAutomationState(uid);
    const now = new Date();
    const slotLabel = `manual-${now.toISOString()}`;
    const runId = crypto.randomUUID();

    await appendAutomationRun(
      uid,
      {
        id: runId,
        slotKey: slotLabel,
        triggeredAt: now.toISOString(),
        status: 'running',
        message: 'Running full video generation pipeline (manual authenticated session)...',
      },
      req.authUser!.idToken
    );

    try {
      const categoryIndex =
        (now.getUTCDate() + (now.getUTCHours() >= 12 ? 1 : 0)) % VIDEO_CATEGORIES.length;
      const category: VideoCategory =
        config.defaultCategory === 'rotate'
          ? VIDEO_CATEGORIES[categoryIndex]
          : config.defaultCategory;

      const history = await getRecentTopicHistory(uid, config.preventDuplicatesWindowDays);
      const suggestions = await generateTopicSuggestions({
        category,
        recentTopics: history.map((h) => h.topic),
        count: 1,
      });

      const chosen = suggestions[0];
      if (!chosen) {
        throw new Error('Gemini returned no topic suggestions.');
      }

      const script = await generateResearchAndScript({
        topic: chosen.topic,
        category,
        targetDurationSeconds: config.defaultDurationSeconds,
      });

      const job: VideoJob = {
        id: crypto.randomUUID(),
        ownerUid: uid,
        topic: chosen.topic,
        category,
        targetDurationSeconds: config.defaultDurationSeconds,
        voiceId: config.defaultVoiceId,
        visualMode: config.defaultVisualMode || 'stock_auto',
        status: 'processing',
        currentStage: 'Starting automated MP4 render',
        progressPercent: 48,
        script,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        source: 'manual',
      };

      await createVideoJob(job, req.authUser!.idToken);
      const completedJob = await executeFullRenderPipeline(job.id);

      await appendAutomationRun(
        uid,
        {
          id: runId,
          slotKey: slotLabel,
          triggeredAt: now.toISOString(),
          status: 'completed',
          videoId: completedJob.id,
          message: `Produced verified ${completedJob.output?.resolution} MP4 (${completedJob.output?.durationSeconds}s): "${completedJob.script?.title}".`,
        },
        req.authUser!.idToken
      );

      res.status(201).json({ video: completedJob, runId });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Manual automation job failed';
      await appendAutomationRun(
        uid,
        {
          id: runId,
          slotKey: slotLabel,
          triggeredAt: now.toISOString(),
          status: 'failed',
          message,
        },
        req.authUser!.idToken
      );
      res.status(err instanceof GeminiServiceError ? err.statusCode : 500).json({
        error: {
          code: err instanceof GeminiServiceError ? err.code : 'AUTOMATION_RUN_FAILED',
          message,
          retryable: err instanceof GeminiServiceError ? err.retryable : true,
        },
      });
    }
  });

  // ---------------------------------------------------------------------------
  // User Settings & Integration Status (never exposes secret values; strictly validated)
  // ---------------------------------------------------------------------------
  router.get('/settings', async (req, res, next) => {
    try {
      const [settings, firestoreProbe] = await Promise.all([
        getSettings(req.authUser!.uid),
        probeFirestoreAdminHealth(),
      ]);
      const config = getServerConfig();
      res.json({
        settings,
        integrations: {
          hasGeminiKey: Boolean(
            config.geminiApiKey && config.geminiApiKey !== 'MY_GEMINI_API_KEY'
          ),
          hasGcsBucket: Boolean(config.gcsBucketName),
          gcsBucketName: config.gcsBucketName || null,
          hasPexelsKey: Boolean(config.pexelsApiKey),
          hasPixabayKey: Boolean(config.pixabayApiKey),
          hasWikimediaSupport: true,
          hasSchedulerSecret: Boolean(config.schedulerSecret),
          firestoreConfigured: firestoreProbe.connected || true,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  router.patch('/settings', async (req, res, next) => {
    try {
      const patch = req.body;
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        validationError(res, 'Request body must be a JSON object.');
        return;
      }

      // Reject unknown keys or attempts to inject API keys, resolution overrides, or secrets
      const allowedKeys = new Set([
        'preferredVisualProvider',
        'subtitleStyle',
        'resolution',
        'fps',
      ]);
      for (const key of Object.keys(patch)) {
        if (!allowedKeys.has(key)) {
          validationError(
            res,
            `Setting field "${key}" cannot be modified from client requests.`,
            'FORBIDDEN_SETTING_FIELD'
          );
          return;
        }
      }

      if (
        patch.preferredVisualProvider !== undefined &&
        patch.preferredVisualProvider !== 'stock_first' &&
        patch.preferredVisualProvider !== 'ai_image_first'
      ) {
        validationError(
          res,
          'preferredVisualProvider must be "stock_first" or "ai_image_first".'
        );
        return;
      }

      if (
        patch.subtitleStyle !== undefined &&
        patch.subtitleStyle !== 'bold_centered' &&
        patch.subtitleStyle !== 'minimal_bottom'
      ) {
        validationError(res, 'subtitleStyle must be "bold_centered" or "minimal_bottom".');
        return;
      }

      if (patch.resolution !== undefined && patch.resolution !== '1080x1920') {
        validationError(res, 'Only 1080x1920 vertical output is permitted.');
        return;
      }

      if (patch.fps !== undefined && patch.fps !== 30) {
        validationError(res, 'Only 30 FPS output is permitted.');
        return;
      }

      const updated = await updateSettings(
        req.authUser!.uid,
        {
          ...(patch.preferredVisualProvider ? { preferredVisualProvider: patch.preferredVisualProvider } : {}),
          ...(patch.subtitleStyle ? { subtitleStyle: patch.subtitleStyle } : {}),
        },
        req.authUser!.idToken
      );

      res.json({ settings: updated });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
