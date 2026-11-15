import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface FfmpegProbeResult {
  available: boolean;
  path?: string;
  ffprobePath?: string;
  version?: string;
  codecs?: string[];
  error?: string;
}

export interface VerifiedMp4Metadata {
  fileSizeBytes: number;
  durationSeconds: number;
  width: number;
  height: number;
  videoCodec: string;
  audioCodec: string;
}

let cachedProbe: FfmpegProbeResult | null = null;

async function findExecutablePath(binName: 'ffmpeg' | 'ffprobe', envVar: string): Promise<string> {
  if (process.env[envVar]) {
    return process.env[envVar]!;
  }
  try {
    const { stdout } = await execFileAsync('which', [binName], { timeout: 3000 });
    const resolved = stdout.trim();
    if (resolved) return resolved;
  } catch {
    // Fall back to PATH lookup
  }
  return binName;
}

export async function probeFfmpeg(forceRefresh = false): Promise<FfmpegProbeResult> {
  if (cachedProbe && !forceRefresh) {
    return cachedProbe;
  }

  const ffmpegPath = await findExecutablePath('ffmpeg', 'FFMPEG_PATH');
  const ffprobePath = await findExecutablePath('ffprobe', 'FFPROBE_PATH');

  try {
    const { stdout } = await execFileAsync(ffmpegPath, ['-version'], { timeout: 5000 });
    const firstLine = stdout.split('\n')[0]?.trim() || '';
    const versionMatch = firstLine.match(/ffmpeg version\s+([^\s]+)/i);
    const version = versionMatch ? versionMatch[1] : firstLine;

    const codecs: string[] = [];
    if (stdout.includes('--enable-libx264')) codecs.push('libx264');
    if (stdout.includes('--enable-libass')) codecs.push('libass');
    if (stdout.includes('--enable-libfreetype')) codecs.push('libfreetype');
    if (stdout.includes('--enable-libmp3lame')) codecs.push('libmp3lame');
    if (stdout.includes('--enable-libopus')) codecs.push('libopus');

    cachedProbe = {
      available: true,
      path: ffmpegPath,
      ffprobePath,
      version,
      codecs,
    };
  } catch (err) {
    cachedProbe = {
      available: false,
      path: ffmpegPath,
      ffprobePath,
      error: err instanceof Error ? err.message : 'FFmpeg executable not found or failed to execute',
    };
  }

  return cachedProbe;
}

export function getCachedFfmpegStatus(): FfmpegProbeResult {
  return cachedProbe ?? { available: false, error: 'FFmpeg probe has not run yet' };
}

export async function verifyRenderedMp4(filePath: string): Promise<VerifiedMp4Metadata> {
  const probe = await probeFfmpeg(false);
  if (!probe.available || !probe.ffprobePath) {
    throw new Error('FFmpeg/FFprobe is not available to verify the rendered MP4.');
  }

  const stat = await fs.stat(filePath);
  if (!stat.isFile() || stat.size < 10_000) {
    throw new Error(`Rendered file "${path.basename(filePath)}" is missing or too small (${stat.size} bytes).`);
  }

  const { stdout } = await execFileAsync(
    probe.ffprobePath,
    [
      '-v',
      'error',
      '-show_entries',
      'format=duration,size:stream=codec_type,codec_name,width,height',
      '-of',
      'json',
      filePath,
    ],
    { timeout: 15000 }
  );

  const parsed = JSON.parse(stdout) as {
    format?: { duration?: string; size?: string };
    streams?: Array<{
      codec_type?: string;
      codec_name?: string;
      width?: number;
      height?: number;
    }>;
  };

  const streams = parsed.streams ?? [];
  const videoStream = streams.find((s) => s.codec_type === 'video');
  const audioStream = streams.find((s) => s.codec_type === 'audio');

  if (!videoStream) {
    throw new Error('Verified MP4 check failed: no video stream found in output.');
  }
  if (!audioStream) {
    throw new Error('Verified MP4 check failed: no audio stream found in output.');
  }

  const durationSeconds = Number(parsed.format?.duration ?? 0);
  if (!Number.isFinite(durationSeconds) || durationSeconds < 1) {
    throw new Error(`Verified MP4 check failed: invalid duration (${durationSeconds}s).`);
  }

  return {
    fileSizeBytes: stat.size,
    durationSeconds: Math.round(durationSeconds * 10) / 10,
    width: Number(videoStream.width ?? 0),
    height: Number(videoStream.height ?? 0),
    videoCodec: videoStream.codec_name || 'unknown',
    audioCodec: audioStream.codec_name || 'unknown',
  };
}
