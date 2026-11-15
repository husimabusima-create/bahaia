import crypto from 'node:crypto';
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import { getServerConfig } from '../config.ts';
import type {
  ScenePlanItem,
  TopicSuggestion,
  VideoCategory,
  VideoScript,
} from '../../src/types.ts';

export const GEMINI_TEXT_MODEL = 'gemini-4-hydrogen';

export class GeminiServiceError extends Error {
  code: string;
  statusCode: number;
  retryable: boolean;

  constructor(code: string, message: string, statusCode: number, retryable: boolean) {
    super(message);
    this.name = 'GeminiServiceError';
    this.code = code;
    this.statusCode = statusCode;
    this.retryable = retryable;
  }
}

function getClient(): GoogleGenAI {
  const { geminiApiKey } = getServerConfig();
  if (!geminiApiKey || geminiApiKey === 'MY_GEMINI_API_KEY') {
    throw new GeminiServiceError(
      'MISSING_API_KEY',
      'GEMINI_API_KEY is not configured on the server. Add it in Settings > Secrets or server environment variables.',
      503,
      false
    );
  }

  return new GoogleGenAI({
    apiKey: geminiApiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function classifyGeminiError(err: unknown): GeminiServiceError {
  if (err instanceof GeminiServiceError) return err;

  const rawMsg = err instanceof Error ? err.message : String(err);
  const lower = rawMsg.toLowerCase();

  if (lower.includes('resource_exhausted') || lower.includes('429') || lower.includes('quota')) {
    return new GeminiServiceError(
      'QUOTA_EXCEEDED',
      'Gemini API rate limit or quota reached. Wait a moment before retrying.',
      429,
      true
    );
  }

  if (
    lower.includes('api_key_invalid') ||
    lower.includes('permission_denied') ||
    lower.includes('401') ||
    lower.includes('403')
  ) {
    return new GeminiServiceError(
      'API_KEY_INVALID',
      'Gemini API key was rejected or lacks permission. Verify GEMINI_API_KEY in Settings > Secrets.',
      403,
      false
    );
  }

  if (lower.includes('timeout') || lower.includes('aborted') || lower.includes('etimedout')) {
    return new GeminiServiceError(
      'API_TIMEOUT',
      'Gemini API request timed out. You can safely retry this operation.',
      504,
      true
    );
  }

  if (lower.includes('404') || lower.includes('not_found')) {
    return new GeminiServiceError(
      'MODEL_NOT_FOUND',
      `Configured Gemini model (${GEMINI_TEXT_MODEL}) was not found or is unavailable.`,
      502,
      false
    );
  }

  return new GeminiServiceError(
    'GEMINI_UPSTREAM_ERROR',
    `Gemini request failed: ${rawMsg}`,
    502,
    true
  );
}

async function runWithTransientRetry<T>(fn: () => Promise<T>, maxRetries = 1): Promise<T> {
  let lastError: GeminiServiceError | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const classified = classifyGeminiError(err);
      lastError = classified;
      if (!classified.retryable || attempt === maxRetries) {
        throw classified;
      }
      const delayMs = 700 * Math.pow(2, attempt);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError ?? new GeminiServiceError('GEMINI_UPSTREAM_ERROR', 'Unknown Gemini error', 502, false);
}

export async function generateTopicSuggestions(params: {
  category: VideoCategory;
  recentTopics: string[];
  count?: number;
}): Promise<TopicSuggestion[]> {
  const count = params.count ?? 4;
  const recentList = params.recentTopics.slice(0, 40);

  return runWithTransientRetry(async () => {
    const ai = getClient();
    const exclusionClause =
      recentList.length > 0
        ? `Do NOT repeat or closely paraphrase any of these recent topics:\n- ${recentList.join('\n- ')}`
        : 'No previous topics recorded yet.';

    const response = await ai.models.generateContent({
      model: GEMINI_TEXT_MODEL,
      contents: `Suggest ${count} distinct, high-retention vertical short-form video (YouTube Shorts / Reels / TikTok) topics in the "${params.category}" category.
Each topic must be specific, factual or richly narrative, visually compelling for 9:16 video, and avoid clickbait fluff.

${exclusionClause}`,
      config: {
        systemInstruction:
          'You are a senior short-form documentary and vertical video producer. Return concise, verified, non-repeating video topic pitches as strict JSON.',
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              topic: {
                type: Type.STRING,
                description: 'Concise topic title (6-12 words).',
              },
              angle: {
                type: Type.STRING,
                description: 'Specific storytelling angle or surprising twist.',
              },
              hookPreview: {
                type: Type.STRING,
                description: 'Sample 1-sentence opening spoken hook under 16 words.',
              },
            },
            required: ['topic', 'angle', 'hookPreview'],
          },
        },
      },
    });

    const rawText = (response.text ?? '[]').trim();
    const parsed = JSON.parse(rawText) as Array<{
      topic: string;
      angle: string;
      hookPreview: string;
    }>;

    return parsed.slice(0, count).map((item) => ({
      id: crypto.randomUUID(),
      topic: String(item.topic || '').trim(),
      category: params.category,
      angle: String(item.angle || '').trim(),
      hookPreview: String(item.hookPreview || '').trim(),
    }));
  });
}

export async function generateResearchAndScript(params: {
  topic: string;
  category: VideoCategory;
  targetDurationSeconds: number;
}): Promise<VideoScript> {
  const duration = Math.max(20, Math.min(90, Math.round(params.targetDurationSeconds)));
  const targetWordCount = Math.round(duration * 2.4);
  const sceneCount = duration <= 30 ? 4 : duration <= 45 ? 6 : 7;

  return runWithTransientRetry(async () => {
    const ai = getClient();

    const response = await ai.models.generateContent({
      model: GEMINI_TEXT_MODEL,
      contents: `Execute the RESEARCH -> SCRIPT -> SCENE PLAN stages for a ${duration}-second vertical (9:16) short-form video.

Topic: "${params.topic}"
Category: ${params.category}
Target Duration: ${duration} seconds (~${targetWordCount} spoken words total)
Target Scene Count: ${sceneCount} sequential scenes

Requirements:
1. Research: Provide a concise factual researchSummary and 3-5 verified keyFacts.
2. Script: Write a compelling opening hook (first 3 seconds), tight mainContent, and punchy ending.
3. Scene Plan: Break the narration into ${sceneCount} sequential scenes whose durationSeconds sum closely to ${duration} seconds.
4. Each scene needs:
   - narrationText: exact spoken lines for that scene
   - subtitleText: punchy 4-8 word caption lines optimized for 9:16 vertical readability
   - visualPrompt: detailed 9:16 portrait visual description for AI image generation
   - stockKeywords: 2-3 clean search terms for stock video/photo fallback
   - transition: one of "cut", "crossfade", "zoom"
   - soundEffectCue: brief subtle audio cue (e.g. "low whoosh", "camera shutter", "subtle riser", or "none")`,
      config: {
        systemInstruction:
          'You are an expert short-form documentary researcher, scriptwriter, and video editor. Write tight, natural spoken narration (no hashtags, no emojis, no stage directions inside narrationText).',
        thinkingConfig: { thinkingLevel: ThinkingLevel.MEDIUM },
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            title: { type: Type.STRING },
            researchSummary: { type: Type.STRING },
            keyFacts: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
            },
            hook: { type: Type.STRING },
            mainContent: { type: Type.STRING },
            ending: { type: Type.STRING },
            musicMood: { type: Type.STRING },
            scenes: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  sceneNumber: { type: Type.INTEGER },
                  durationSeconds: { type: Type.NUMBER },
                  narrationText: { type: Type.STRING },
                  subtitleText: { type: Type.STRING },
                  visualPrompt: { type: Type.STRING },
                  stockKeywords: {
                    type: Type.ARRAY,
                    items: { type: Type.STRING },
                  },
                  transition: { type: Type.STRING },
                  soundEffectCue: { type: Type.STRING },
                },
                required: [
                  'sceneNumber',
                  'durationSeconds',
                  'narrationText',
                  'subtitleText',
                  'visualPrompt',
                  'stockKeywords',
                  'transition',
                ],
              },
            },
          },
          required: [
            'title',
            'researchSummary',
            'keyFacts',
            'hook',
            'mainContent',
            'ending',
            'musicMood',
            'scenes',
          ],
        },
      },
    });

    const rawText = (response.text ?? '{}').trim();
    const parsed = JSON.parse(rawText) as {
      title: string;
      researchSummary: string;
      keyFacts: string[];
      hook: string;
      mainContent: string;
      ending: string;
      musicMood: string;
      scenes: Array<{
        sceneNumber: number;
        durationSeconds: number;
        narrationText: string;
        subtitleText: string;
        visualPrompt: string;
        stockKeywords: string[];
        transition: string;
        soundEffectCue?: string;
      }>;
    };

    const scenes: ScenePlanItem[] = (parsed.scenes || []).map((s, idx) => {
      const transition =
        s.transition === 'crossfade' || s.transition === 'zoom' ? s.transition : 'cut';
      return {
        id: crypto.randomUUID(),
        sceneNumber: idx + 1,
        durationSeconds: Math.max(2, Math.round((Number(s.durationSeconds) || 5) * 10) / 10),
        narrationText: String(s.narrationText || '').trim(),
        subtitleText: String(s.subtitleText || '').trim(),
        visualPrompt: String(s.visualPrompt || '').trim(),
        stockKeywords: Array.isArray(s.stockKeywords)
          ? s.stockKeywords.map((k) => String(k).trim()).filter(Boolean).slice(0, 4)
          : [],
        transition,
        soundEffectCue: s.soundEffectCue ? String(s.soundEffectCue).trim() : undefined,
        assetSource: 'unassigned',
      };
    });

    const estimatedDurationSeconds = Math.round(
      scenes.reduce((acc, s) => acc + s.durationSeconds, 0)
    );
    const fullNarration = scenes.map((s) => s.narrationText).filter(Boolean).join(' ');

    return {
      title: String(parsed.title || params.topic).trim(),
      researchSummary: String(parsed.researchSummary || '').trim(),
      keyFacts: Array.isArray(parsed.keyFacts)
        ? parsed.keyFacts.map((f) => String(f).trim()).filter(Boolean)
        : [],
      hook: String(parsed.hook || '').trim(),
      mainContent: String(parsed.mainContent || '').trim(),
      ending: String(parsed.ending || '').trim(),
      fullNarration: fullNarration || `${parsed.hook} ${parsed.mainContent} ${parsed.ending}`.trim(),
      estimatedDurationSeconds: estimatedDurationSeconds || duration,
      musicMood: String(parsed.musicMood || 'subtle cinematic ambient').trim(),
      scenes,
    };
  });
}
