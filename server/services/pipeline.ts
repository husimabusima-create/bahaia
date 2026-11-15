import fs from 'node:fs/promises';
import { probeFfmpeg } from './ffmpeg.ts';
import { GeminiServiceError } from './gemini.ts';
import { renderFinalMp4 } from './renderer.ts';
import { uploadArtifactToGcs } from './storage.ts';
import { getSettings, getVideoById, updateVideoJob } from './store.ts';
import { generateSceneNarration } from './tts.ts';
import { acquireSceneVisual, VisualProviderError } from './visuals.ts';
import type { ScenePlanItem, VideoJob } from '../../src/types.ts';

const activeRenderJobs = new Set<string>();

export function isJobRendering(videoId: string): boolean {
  return activeRenderJobs.has(videoId);
}

function classifyPipelineError(err: unknown, stage: string) {
  if (err instanceof GeminiServiceError) {
    return {
      code: err.code,
      message: err.message,
      retryable: err.retryable,
      stage,
      occurredAt: new Date().toISOString(),
    };
  }
  if (err instanceof VisualProviderError) {
    return {
      code: err.code,
      message: err.message,
      retryable: err.retryable,
      stage,
      occurredAt: new Date().toISOString(),
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    code: 'RENDER_PIPELINE_ERROR',
    message,
    retryable: true,
    stage,
    occurredAt: new Date().toISOString(),
  };
}

export async function executeFullRenderPipeline(videoId: string): Promise<VideoJob> {
  if (activeRenderJobs.has(videoId)) {
    const current = await getVideoById(videoId);
    if (current) return current;
    throw new Error('Render job is already running.');
  }

  activeRenderJobs.add(videoId);
  let currentStage = 'preflight';

  try {
    const job = await getVideoById(videoId);
    if (!job || !job.script) {
      throw new Error('Video record or script not found.');
    }

    const ffmpegStatus = await probeFfmpeg(true);
    if (!ffmpegStatus.available) {
      throw new Error(`FFmpeg unavailable on server: ${ffmpegStatus.error}`);
    }

    const settings = await getSettings(job.ownerUid);
    const scenes: ScenePlanItem[] = structuredClone(job.script.scenes);
    const usedUrls = new Set<string>();

    // Stage: Narration (Gemini TTS per scene, synced durations, reusing unchanged WAVs on retry)
    currentStage = 'narration';
    await updateVideoJob(videoId, {
      status: 'processing',
      currentStage: 'Generating TTS narration per scene',
      progressPercent: 52,
      error: undefined,
    });

    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];
      let hasReusableAudio = false;
      if (scene.audioLocalPath && scene.audioUrl && (scene.actualAudioDurationSeconds ?? 0) > 0) {
        try {
          const stat = await fs.stat(scene.audioLocalPath);
          if (stat.isFile() && stat.size > 44) {
            hasReusableAudio = true;
          }
        } catch {
          hasReusableAudio = false;
        }
      }

      if (hasReusableAudio) {
        scene.durationSeconds = scene.actualAudioDurationSeconds!;
        continue;
      }

      await updateVideoJob(videoId, {
        currentStage: `Generating narration for Scene ${i + 1} of ${scenes.length}`,
        progressPercent: 52 + Math.round((i / scenes.length) * 16),
      });

      const audio = await generateSceneNarration({
        videoId,
        scene,
        voiceId: job.voiceId,
        category: job.category,
      });

      scene.audioLocalPath = audio.localPath;
      scene.audioUrl = audio.audioUrl;
      scene.actualAudioDurationSeconds = audio.durationSeconds;
      scene.durationSeconds = audio.durationSeconds;

      if (i < scenes.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 350));
      }
    }

    const updatedScriptAfterAudio = {
      ...job.script,
      scenes,
      estimatedDurationSeconds: Math.round(
        scenes.reduce((acc, s) => acc + s.durationSeconds, 0)
      ),
    };
    await updateVideoJob(videoId, { script: updatedScriptAfterAudio });

    // Stage: Visuals (Licensed stock media or AI image per scene)
    currentStage = 'visuals';
    await updateVideoJob(videoId, {
      currentStage: 'Acquiring scene visuals',
      progressPercent: 70,
    });

    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];
      await updateVideoJob(videoId, {
        currentStage: `Fetching visual for Scene ${i + 1} of ${scenes.length}`,
        progressPercent: 70 + Math.round((i / scenes.length) * 14),
      });

      const visual = await acquireSceneVisual({
        videoId,
        scene,
        visualMode: job.visualMode || 'stock_auto',
        fallbackTopic: job.topic,
        fallbackCategory: job.category,
        usedUrls,
      });

      scene.assetSource = visual.assetSource;
      scene.providerName = visual.providerName;
      scene.attribution = visual.attribution;
      scene.assetLocalPath = visual.assetLocalPath;
      scene.assetUrl = visual.assetUrl;
    }

    const updatedScriptWithVisuals = {
      ...updatedScriptAfterAudio,
      scenes,
    };
    await updateVideoJob(videoId, { script: updatedScriptWithVisuals });

    // Stage: FFmpeg Video Editing, Subtitles, Audio Mix & MP4 Verification
    currentStage = 'rendering';
    await updateVideoJob(videoId, {
      currentStage: 'Editing video, burning subtitles, and rendering 1080×1920 MP4',
      progressPercent: 86,
    });

    const rendered = await renderFinalMp4({
      videoId,
      script: updatedScriptWithVisuals,
      subtitleStyle: settings.subtitleStyle,
    });

    const verifiedOutput = {
      streamUrl: `/api/videos/${videoId}/stream`,
      downloadUrl: `/api/videos/${videoId}/download`,
      thumbnailUrl: `/api/videos/${videoId}/thumbnail`,
      fileSizeBytes: rendered.metadata.fileSizeBytes,
      durationSeconds: rendered.metadata.durationSeconds,
      resolution: `${rendered.metadata.width}x${rendered.metadata.height}`,
      videoCodec: rendered.metadata.videoCodec,
      audioCodec: rendered.metadata.audioCodec,
      verifiedAt: new Date().toISOString(),
    };

    await updateVideoJob(videoId, { output: verifiedOutput });

    // Stage: Permanent Storage (GCS if configured and accessible; verified local storage fallback otherwise)
    currentStage = 'storage';
    await updateVideoJob(videoId, {
      currentStage: 'Saving verified MP4 and thumbnail',
      progressPercent: 95,
    });

    const mp4Upload = await uploadArtifactToGcs({
      localFilePath: rendered.mp4Path,
      destinationKey: `videos/${videoId}/final.mp4`,
      contentType: 'video/mp4',
    });

    const thumbUpload = mp4Upload
      ? await uploadArtifactToGcs({
          localFilePath: rendered.thumbnailPath,
          destinationKey: `videos/${videoId}/thumbnail.jpg`,
          contentType: 'image/jpeg',
        })
      : null;

    const finalJob = await updateVideoJob(videoId, {
      status: 'completed',
      currentStage: mp4Upload
        ? 'Completed and synced to Cloud Storage'
        : 'Completed and verified',
      progressPercent: 100,
      output: {
        ...verifiedOutput,
        gcsUri: mp4Upload?.gcsUri,
        thumbnailGcsUri: thumbUpload?.gcsUri,
      },
    });

    return finalJob!;
  } catch (err) {
    const errInfo = classifyPipelineError(err, currentStage);
    await updateVideoJob(videoId, {
      status: 'failed',
      currentStage: `Failed at ${currentStage}`,
      error: errInfo,
    });
    throw err;
  } finally {
    activeRenderJobs.delete(videoId);
  }
}
