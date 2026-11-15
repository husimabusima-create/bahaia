import fs from 'node:fs/promises';
import path from 'node:path';
import { GoogleGenAI } from '@google/genai';
import { getServerConfig } from '../config.ts';
import { GeminiServiceError } from './gemini.ts';
import { ensureJobWorkDir } from './storage.ts';
import type { ScenePlanItem, VisualMode } from '../../src/types.ts';

export const GEMINI_IMAGE_MODEL = 'gemini-3.1-flash-lite-image';

export class VisualProviderError extends Error {
  code: string;
  retryable: boolean;

  constructor(code: string, message: string, retryable = true) {
    super(message);
    this.name = 'VisualProviderError';
    this.code = code;
    this.retryable = retryable;
  }
}

export interface SceneVisualResult {
  assetSource: 'ai_image' | 'stock_video' | 'stock_image';
  providerName: string;
  attribution: string;
  assetLocalPath: string;
  assetUrl: string;
}

async function downloadFileToDisk(url: string, destPath: string, headers?: Record<string, string>): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'ShortForge-Studio/1.0 (https://shortforge.local)',
        ...(headers ?? {}),
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new VisualProviderError(
        'MEDIA_DOWNLOAD_FAILED',
        `Failed to download media asset (${res.status} ${res.statusText}).`,
        true
      );
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1024) {
      throw new VisualProviderError(
        'MEDIA_DOWNLOAD_INVALID',
        'Downloaded media asset was empty or corrupted.',
        true
      );
    }
    await fs.writeFile(destPath, buf);
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchFromPexels(params: {
  query: string;
  usedUrls: Set<string>;
  workDir: string;
  videoId: string;
  sceneNumber: number;
}): Promise<SceneVisualResult | null> {
  const { pexelsApiKey } = getServerConfig();
  if (!pexelsApiKey) return null;

  // 1. Try portrait stock video first
  const videoRes = await fetch(
    `https://api.pexels.com/videos/search?query=${encodeURIComponent(params.query)}&orientation=portrait&per_page=8`,
    { headers: { Authorization: pexelsApiKey } }
  );
  if (!videoRes.ok) {
    if (videoRes.status === 401 || videoRes.status === 403) {
      throw new VisualProviderError('PEXELS_AUTH_FAILED', 'PEXELS_API_KEY was rejected (401/403).', false);
    }
    if (videoRes.status === 429) {
      throw new VisualProviderError('PEXELS_RATE_LIMIT', 'Pexels API rate limit reached (429).', false);
    }
  } else {
    const data = (await videoRes.json()) as {
      videos?: Array<{
        id: number;
        url: string;
        user?: { name?: string };
        video_files?: Array<{ link: string; width: number; height: number; file_type: string }>;
      }>;
    };
    for (const vid of data.videos ?? []) {
      const files = (vid.video_files ?? [])
        .filter((f) => f.file_type === 'video/mp4' && f.height >= f.width)
        .sort((a, b) => Math.abs(b.width - 1080) - Math.abs(a.width - 1080));
      const best = files[files.length - 1] ?? vid.video_files?.[0];
      if (best?.link && !params.usedUrls.has(best.link)) {
        params.usedUrls.add(best.link);
        const fileName = `scene_${params.sceneNumber}_pexels.mp4`;
        const localPath = path.join(params.workDir, fileName);
        await downloadFileToDisk(best.link, localPath);
        return {
          assetSource: 'stock_video',
          providerName: 'Pexels',
          attribution: `Stock Video by ${vid.user?.name || 'Pexels Creator'} (Pexels)`,
          assetLocalPath: localPath,
          assetUrl: `/api/media/${params.videoId}/${fileName}`,
        };
      }
    }
  }

  // 2. Fallback to portrait stock photo on Pexels
  const photoRes = await fetch(
    `https://api.pexels.com/v1/search?query=${encodeURIComponent(params.query)}&orientation=portrait&per_page=8`,
    { headers: { Authorization: pexelsApiKey } }
  );
  if (!photoRes.ok) {
    if (photoRes.status === 401 || photoRes.status === 403) {
      throw new VisualProviderError('PEXELS_AUTH_FAILED', 'PEXELS_API_KEY was rejected (401/403).', false);
    }
    if (photoRes.status === 429) {
      throw new VisualProviderError('PEXELS_RATE_LIMIT', 'Pexels API rate limit reached (429).', false);
    }
  } else {
    const data = (await photoRes.json()) as {
      photos?: Array<{
        photographer?: string;
        src?: { large2x?: string; portrait?: string; original?: string };
      }>;
    };
    for (const photo of data.photos ?? []) {
      const link = photo.src?.large2x || photo.src?.portrait || photo.src?.original;
      if (link && !params.usedUrls.has(link)) {
        params.usedUrls.add(link);
        const fileName = `scene_${params.sceneNumber}_pexels.jpg`;
        const localPath = path.join(params.workDir, fileName);
        await downloadFileToDisk(link, localPath);
        return {
          assetSource: 'stock_image',
          providerName: 'Pexels',
          attribution: `Stock Photo by ${photo.photographer || 'Pexels Creator'} (Pexels)`,
          assetLocalPath: localPath,
          assetUrl: `/api/media/${params.videoId}/${fileName}`,
        };
      }
    }
  }

  return null;
}

async function classifyPixabayFailure(res: Response): Promise<never> {
  const bodyText = await res.text().catch(() => '');
  if (res.status === 429) {
    throw new VisualProviderError('PIXABAY_RATE_LIMIT', 'Pixabay API rate limit reached (429).', false);
  }
  if (res.status === 400 || res.status === 401 || res.status === 403) {
    throw new VisualProviderError(
      'PIXABAY_AUTH_FAILED',
      `Pixabay API key rejected (${res.status}): ${bodyText.slice(0, 120) || 'Invalid or unauthorized PIXABAY_API_KEY.'}`,
      false
    );
  }
  throw new VisualProviderError(
    'PIXABAY_UPSTREAM_ERROR',
    `Pixabay request failed (${res.status} ${res.statusText}).`,
    true
  );
}

async function fetchFromPixabay(params: {
  query: string;
  usedUrls: Set<string>;
  workDir: string;
  videoId: string;
  sceneNumber: number;
}): Promise<SceneVisualResult | null> {
  const { pixabayApiKey } = getServerConfig();
  if (!pixabayApiKey) return null;

  const videoRes = await fetch(
    `https://pixabay.com/api/videos/?key=${encodeURIComponent(pixabayApiKey)}&q=${encodeURIComponent(params.query)}&per_page=8`
  );
  if (!videoRes.ok) {
    await classifyPixabayFailure(videoRes);
  }
  const videoData = (await videoRes.json()) as {
    hits?: Array<{
      user?: string;
      videos?: { medium?: { url?: string }; large?: { url?: string } };
    }>;
  };
  for (const hit of videoData.hits ?? []) {
    const link = hit.videos?.large?.url || hit.videos?.medium?.url;
    if (link && !params.usedUrls.has(link)) {
      params.usedUrls.add(link);
      const fileName = `scene_${params.sceneNumber}_pixabay.mp4`;
      const localPath = path.join(params.workDir, fileName);
      await downloadFileToDisk(link, localPath);
      return {
        assetSource: 'stock_video',
        providerName: 'Pixabay',
        attribution: `Stock Video by ${hit.user || 'Pixabay Contributor'} (Pixabay)`,
        assetLocalPath: localPath,
        assetUrl: `/api/media/${params.videoId}/${fileName}`,
      };
    }
  }

  const photoRes = await fetch(
    `https://pixabay.com/api/?key=${encodeURIComponent(pixabayApiKey)}&q=${encodeURIComponent(params.query)}&image_type=photo&orientation=vertical&per_page=8`
  );
  if (!photoRes.ok) {
    await classifyPixabayFailure(photoRes);
  }
  const photoData = (await photoRes.json()) as {
    hits?: Array<{ user?: string; largeImageURL?: string }>;
  };
  for (const hit of photoData.hits ?? []) {
    const link = hit.largeImageURL;
    if (link && !params.usedUrls.has(link)) {
      params.usedUrls.add(link);
      const fileName = `scene_${params.sceneNumber}_pixabay.jpg`;
      const localPath = path.join(params.workDir, fileName);
      await downloadFileToDisk(link, localPath);
      return {
        assetSource: 'stock_image',
        providerName: 'Pixabay',
        attribution: `Stock Photo by ${hit.user || 'Pixabay Contributor'} (Pixabay)`,
        assetLocalPath: localPath,
        assetUrl: `/api/media/${params.videoId}/${fileName}`,
      };
    }
  }

  return null;
}

async function fetchFromWikimediaCommons(params: {
  query: string;
  usedUrls: Set<string>;
  workDir: string;
  videoId: string;
  sceneNumber: number;
}): Promise<SceneVisualResult | null> {
  // Genuine free open-license media search (CC/Public Domain) via Wikimedia Commons API
  const words = params.query.split(/\s+/).filter(Boolean);
  const twoWord = words.length >= 2 ? words.slice(0, 2).join(' ') : '';
  const searchTerms = Array.from(new Set([params.query, twoWord, ...words.slice(0, 2)].filter(Boolean)));
  for (const term of searchTerms) {
    const apiUrl =
      `https://commons.wikimedia.org/w/api.php?action=query&generator=search` +
      `&gsrnamespace=6&gsrsearch=${encodeURIComponent(term + ' filetype:bitmap')}` +
      `&gsrlimit=10&prop=imageinfo&iiprop=url|mime|size|extmetadata&iiurlwidth=1200&format=json&origin=*`;

    const res = await fetch(apiUrl, {
      headers: { 'User-Agent': 'ShortForge-Studio/1.0 (https://shortforge.local)' },
    });
    if (!res.ok) continue;

    const data = (await res.json()) as {
      query?: {
        pages?: Record<
          string,
          {
            title?: string;
            imageinfo?: Array<{
              url?: string;
              thumburl?: string;
              mime?: string;
              width?: number;
              height?: number;
              extmetadata?: {
                LicenseShortName?: { value?: string };
                Artist?: { value?: string };
              };
            }>;
          }
        >;
      };
    };

    const pages = Object.values(data.query?.pages ?? {});
    for (const page of pages) {
      const info = page.imageinfo?.[0];
      if (!info) continue;
      if (info.mime !== 'image/jpeg' && info.mime !== 'image/png') continue;
      if ((info.width ?? 0) < 600 || (info.height ?? 0) < 400) continue;

      const mediaUrl = info.thumburl || info.url;
      if (!mediaUrl || params.usedUrls.has(mediaUrl)) continue;

      params.usedUrls.add(mediaUrl);
      const ext = info.mime === 'image/png' ? 'png' : 'jpg';
      const fileName = `scene_${params.sceneNumber}_wikimedia.${ext}`;
      const localPath = path.join(params.workDir, fileName);

      try {
        await downloadFileToDisk(mediaUrl, localPath);
        const license = info.extmetadata?.LicenseShortName?.value || 'Open License';
        const rawArtist = info.extmetadata?.Artist?.value?.replace(/<[^>]+>/g, '').trim();
        const artist = rawArtist ? rawArtist.slice(0, 48) : 'Wikimedia Commons';
        return {
          assetSource: 'stock_image',
          providerName: 'Wikimedia Commons',
          attribution: `Stock Image (${license}) · ${artist}`,
          assetLocalPath: localPath,
          assetUrl: `/api/media/${params.videoId}/${fileName}`,
        };
      } catch {
        continue;
      }
    }
  }
  return null;
}

async function generateGeminiSceneImage(params: {
  prompt: string;
  workDir: string;
  videoId: string;
  sceneNumber: number;
}): Promise<SceneVisualResult> {
  const { geminiApiKey } = getServerConfig();
  if (!geminiApiKey || geminiApiKey === 'MY_GEMINI_API_KEY') {
    throw new GeminiServiceError(
      'MISSING_API_KEY',
      'GEMINI_API_KEY is missing on the server.',
      503,
      false
    );
  }

  const ai = new GoogleGenAI({
    apiKey: geminiApiKey,
    apiVersion: 'v1beta',
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });

  try {
    const response = await ai.models.generateContent({
      model: GEMINI_IMAGE_MODEL,
      contents: {
        parts: [
          {
            text: `Vertical 9:16 editorial documentary frame, cinematic lighting, high detail, no embedded text or watermarks: ${params.prompt}`,
          },
        ],
      },
      config: {
        imageConfig: {
          aspectRatio: '9:16',
        },
      },
    });

    for (const part of response.candidates?.[0]?.content?.parts ?? []) {
      if (part.inlineData?.data) {
        const mime = part.inlineData.mimeType ?? 'image/png';
        const ext = mime.includes('jpeg') || mime.includes('jpg') ? 'jpg' : 'png';
        const fileName = `scene_${params.sceneNumber}_gemini.${ext}`;
        const localPath = path.join(params.workDir, fileName);
        await fs.writeFile(localPath, Buffer.from(part.inlineData.data, 'base64'));
        return {
          assetSource: 'ai_image',
          providerName: 'Gemini Image',
          attribution: `AI Generated (${GEMINI_IMAGE_MODEL})`,
          assetLocalPath: localPath,
          assetUrl: `/api/media/${params.videoId}/${fileName}`,
        };
      }
    }

    throw new VisualProviderError(
      'AI_IMAGE_EMPTY',
      'Gemini image generation returned no image data.',
      true
    );
  } catch (err) {
    if (err instanceof VisualProviderError || err instanceof GeminiServiceError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    const lower = msg.toLowerCase();
    if (lower.includes('resource_exhausted') || lower.includes('429') || lower.includes('quota')) {
      throw new VisualProviderError(
        'PAID_KEY_OR_QUOTA_REQUIRED',
        'Gemini AI image generation requires a billing-enabled paid API key or hit quota limits. Switch Visual Mode to Stock Media or upgrade your API key.',
        false
      );
    }
    if (lower.includes('403') || lower.includes('permission_denied')) {
      throw new VisualProviderError(
        'PAID_KEY_OR_QUOTA_REQUIRED',
        'Gemini AI image generation was denied (requires paid API tier). Use Stock Media or check API key billing.',
        false
      );
    }
    throw new VisualProviderError('AI_IMAGE_FAILED', `AI image generation failed: ${msg}`, true);
  }
}

export async function acquireSceneVisual(params: {
  videoId: string;
  scene: ScenePlanItem;
  visualMode: VisualMode;
  fallbackTopic: string;
  fallbackCategory?: string;
  usedUrls: Set<string>;
}): Promise<SceneVisualResult> {
  const workDir = await ensureJobWorkDir(params.videoId);
  const query =
    params.scene.stockKeywords.length > 0
      ? params.scene.stockKeywords.slice(0, 3).join(' ')
      : params.fallbackTopic;

  if (params.visualMode === 'ai_image') {
    return generateGeminiSceneImage({
      prompt: params.scene.visualPrompt || params.fallbackTopic,
      workDir,
      videoId: params.videoId,
      sceneNumber: params.scene.sceneNumber,
    });
  }

  if (params.visualMode === 'pexels') {
    const { pexelsApiKey } = getServerConfig();
    if (!pexelsApiKey) {
      throw new VisualProviderError(
        'MISSING_PEXELS_KEY',
        'PEXELS_API_KEY is not configured on the server.',
        false
      );
    }
    const res = await fetchFromPexels({
      query,
      usedUrls: params.usedUrls,
      workDir,
      videoId: params.videoId,
      sceneNumber: params.scene.sceneNumber,
    });
    if (!res) {
      throw new VisualProviderError(
        'NO_STOCK_MATCH',
        `No Pexels media found for keywords "${query}". Edit the scene keywords and retry.`,
        true
      );
    }
    return res;
  }

  if (params.visualMode === 'pixabay') {
    const { pixabayApiKey } = getServerConfig();
    if (!pixabayApiKey) {
      throw new VisualProviderError(
        'MISSING_PIXABAY_KEY',
        'PIXABAY_API_KEY is not configured on the server.',
        false
      );
    }
    const res = await fetchFromPixabay({
      query,
      usedUrls: params.usedUrls,
      workDir,
      videoId: params.videoId,
      sceneNumber: params.scene.sceneNumber,
    });
    if (!res) {
      throw new VisualProviderError(
        'NO_STOCK_MATCH',
        `No Pixabay media found for keywords "${query}". Edit the scene keywords and retry.`,
        true
      );
    }
    return res;
  }

  if (params.visualMode === 'wikimedia') {
    const res = await fetchFromWikimediaCommons({
      query,
      usedUrls: params.usedUrls,
      workDir,
      videoId: params.videoId,
      sceneNumber: params.scene.sceneNumber,
    });
    if (res) return res;

    const broadRes = await fetchFromWikimediaCommons({
      query: params.fallbackTopic,
      usedUrls: params.usedUrls,
      workDir,
      videoId: params.videoId,
      sceneNumber: params.scene.sceneNumber,
    });
    if (broadRes) return broadRes;

    if (params.fallbackCategory) {
      const catRes = await fetchFromWikimediaCommons({
        query: params.fallbackCategory,
        usedUrls: params.usedUrls,
        workDir,
        videoId: params.videoId,
        sceneNumber: params.scene.sceneNumber,
      });
      if (catRes) return catRes;
    }

    throw new VisualProviderError(
      'NO_STOCK_MATCH',
      `No Wikimedia Commons open-license image found for "${query}". Adjust scene keywords and retry.`,
      true
    );
  }

  // stock_auto: Check configured stock providers in explicit priority order (Pexels -> Pixabay -> Wikimedia Commons)
  const providerErrors: string[] = [];

  try {
    const fromPexels = await fetchFromPexels({
      query,
      usedUrls: params.usedUrls,
      workDir,
      videoId: params.videoId,
      sceneNumber: params.scene.sceneNumber,
    });
    if (fromPexels) return fromPexels;
  } catch (err) {
    providerErrors.push(err instanceof Error ? err.message : 'Pexels lookup failed');
  }

  try {
    const fromPixabay = await fetchFromPixabay({
      query,
      usedUrls: params.usedUrls,
      workDir,
      videoId: params.videoId,
      sceneNumber: params.scene.sceneNumber,
    });
    if (fromPixabay) return fromPixabay;
  } catch (err) {
    providerErrors.push(err instanceof Error ? err.message : 'Pixabay lookup failed');
  }

  try {
    const fromWiki = await fetchFromWikimediaCommons({
      query,
      usedUrls: params.usedUrls,
      workDir,
      videoId: params.videoId,
      sceneNumber: params.scene.sceneNumber,
    });
    if (fromWiki) return fromWiki;

    // Broader topic search on Wikimedia Commons before failing
    const broadWiki = await fetchFromWikimediaCommons({
      query: params.fallbackTopic,
      usedUrls: params.usedUrls,
      workDir,
      videoId: params.videoId,
      sceneNumber: params.scene.sceneNumber,
    });
    if (broadWiki) return broadWiki;

    if (params.fallbackCategory) {
      const catWiki = await fetchFromWikimediaCommons({
        query: params.fallbackCategory,
        usedUrls: params.usedUrls,
        workDir,
        videoId: params.videoId,
        sceneNumber: params.scene.sceneNumber,
      });
      if (catWiki) return catWiki;
    }
  } catch (err) {
    providerErrors.push(err instanceof Error ? err.message : 'Wikimedia Commons lookup failed');
  }

  const detailSuffix = providerErrors.length > 0 ? ` Provider errors: ${providerErrors.join(' | ')}` : '';
  throw new VisualProviderError(
    'VISUAL_ACQUISITION_FAILED',
    `Could not find licensed stock media for Scene ${params.scene.sceneNumber} ("${query}").${detailSuffix}`,
    true
  );
}
