import fs from 'node:fs/promises';
import path from 'node:path';
import { GoogleGenAI } from '@google/genai';
import { getServerConfig } from '../config.ts';
import { GeminiServiceError } from './gemini.ts';
import { ensureJobWorkDir } from './storage.ts';
import type { ScenePlanItem, VideoCategory } from '../../src/types.ts';

export const GEMINI_TTS_MODEL = 'gemini-3.8-flash-lite-tts';

const VOICE_STYLE_HINTS: Record<VideoCategory, string> = {
  educational: 'Clear, engaging, well-paced documentary educator',
  history: 'Warm, evocative historical storyteller with crisp diction',
  technology: 'Sharp, modern, confident tech explainer',
  science: 'Curious, lucid science communicator with natural emphasis',
  mystery: 'Measured, intriguing investigative narrator',
  storytelling: 'Expressive, cinematic short-form narrator',
};

function getClient(): GoogleGenAI {
  const { geminiApiKey } = getServerConfig();
  if (!geminiApiKey || geminiApiKey === 'MY_GEMINI_API_KEY') {
    throw new GeminiServiceError(
      'MISSING_API_KEY',
      'GEMINI_API_KEY is missing on the server. Required for Gemini TTS narration.',
      503,
      false
    );
  }
  return new GoogleGenAI({
    apiKey: geminiApiKey,
    apiVersion: 'v1beta',
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function measureWavDurationSeconds(wavBuffer: Buffer): number {
  // Gemini unary TTS returns 24kHz, mono, 16-bit PCM WAV (44-byte RIFF header => 48,000 bytes/sec).
  if (wavBuffer.length <= 44) return 2;
  const sampleRate = wavBuffer.readUInt32LE(24) || 24000;
  const byteRate = wavBuffer.readUInt32LE(28) || sampleRate * 2;
  const dataBytes = wavBuffer.length - 44;
  return Math.max(1.5, Math.round((dataBytes / byteRate) * 100) / 100);
}

function classifyTtsError(err: unknown): GeminiServiceError {
  if (err instanceof GeminiServiceError) return err;
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();

  if (lower.includes('resource_exhausted') || lower.includes('429') || lower.includes('quota')) {
    return new GeminiServiceError(
      'QUOTA_EXCEEDED',
      'Gemini TTS rate limit or quota reached. Wait a moment and retry narration.',
      429,
      true
    );
  }
  if (lower.includes('api_key_invalid') || lower.includes('permission_denied') || lower.includes('403')) {
    return new GeminiServiceError(
      'API_KEY_INVALID',
      'Gemini API key rejected during TTS narration generation.',
      403,
      false
    );
  }
  if (lower.includes('timeout') || lower.includes('etimedout')) {
    return new GeminiServiceError(
      'API_TIMEOUT',
      'Gemini TTS request timed out. You can retry narration generation.',
      504,
      true
    );
  }
  return new GeminiServiceError('NARRATION_FAILED', `TTS generation failed: ${msg}`, 502, true);
}

export async function generateSceneNarration(params: {
  videoId: string;
  scene: ScenePlanItem;
  voiceId: string;
  category: VideoCategory;
}): Promise<{ localPath: string; audioUrl: string; durationSeconds: number }> {
  const workDir = await ensureJobWorkDir(params.videoId);
  const fileName = `narration_scene_${params.scene.sceneNumber}.wav`;
  const localPath = path.join(workDir, fileName);

  const text = params.scene.narrationText.trim();
  if (!text) {
    throw new GeminiServiceError(
      'EMPTY_NARRATION',
      `Scene ${params.scene.sceneNumber} has empty narration text.`,
      400,
      false
    );
  }

  let lastError: GeminiServiceError | null = null;
  for (let attempt = 0; attempt <= 2; attempt++) {
    try {
      const ai = getClient();
      const response = await ai.models.generateContent({
        model: GEMINI_TTS_MODEL,
        contents: [
          {
            role: 'user',
            parts: [
              {
                text,
                speechMetadata: {
                  style: VOICE_STYLE_HINTS[params.category] || 'Clear, engaging short-form narrator',
                },
              },
            ],
          },
        ],
        config: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: params.voiceId || 'Kore',
              },
            },
          },
        },
      });

      const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (!base64Audio) {
        throw new Error('Gemini TTS response did not contain audio bytes.');
      }

      const wavBuffer = Buffer.from(base64Audio, 'base64');
      await fs.writeFile(localPath, wavBuffer);

      const durationSeconds = measureWavDurationSeconds(wavBuffer);
      return {
        localPath,
        audioUrl: `/api/media/${params.videoId}/${fileName}`,
        durationSeconds,
      };
    } catch (err) {
      const classified = classifyTtsError(err);
      lastError = classified;
      if (!classified.retryable || attempt === 2) {
        throw classified;
      }
      const delayMs = classified.code === 'QUOTA_EXCEEDED' ? 2500 * (attempt + 1) : 1000 * (attempt + 1);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError ?? new GeminiServiceError('NARRATION_FAILED', 'TTS generation failed.', 502, true);
}
