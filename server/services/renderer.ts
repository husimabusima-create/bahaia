import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { probeFfmpeg, verifyRenderedMp4, type VerifiedMp4Metadata } from './ffmpeg.ts';
import {
  ensureJobWorkDir,
  getFinalMp4Path,
  getThumbnailPath,
} from './storage.ts';
import type { AppSettings, ScenePlanItem, VideoScript } from '../../src/types.ts';

const execFileAsync = promisify(execFile);

function formatAssTimestamp(seconds: number): string {
  const clamped = Math.max(0, seconds);
  const hrs = Math.floor(clamped / 3600);
  const mins = Math.floor((clamped % 3600) / 60);
  const secs = Math.floor(clamped % 60);
  const cs = Math.floor((clamped - Math.floor(clamped)) * 100);
  return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function escapeAssText(text: string): string {
  return text.replace(/\r?\n/g, '\\N').replace(/\{/g, '(').replace(/\}/g, ')');
}

function splitCaptionChunks(text: string, maxWordsPerChunk = 5): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const chunks: string[] = [];
  for (let i = 0; i < words.length; i += maxWordsPerChunk) {
    chunks.push(words.slice(i, i + maxWordsPerChunk).join(' '));
  }
  return chunks;
}

async function generateAssSubtitles(params: {
  workDir: string;
  scenes: ScenePlanItem[];
  subtitleStyle: AppSettings['subtitleStyle'];
}): Promise<string> {
  const assPath = path.join(params.workDir, 'subtitles.ass');
  const isCentered = params.subtitleStyle === 'bold_centered';
  const alignment = isCentered ? 2 : 2;
  const marginV = isCentered ? 420 : 180;
  const fontSize = isCentered ? 64 : 52;

  const header = `[Script Info]
Title: ShortForge Subtitles
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,DejaVu Sans,${fontSize},&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,4,2,${alignment},70,70,${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const lines: string[] = [];
  let cursor = 0;

  for (const scene of params.scenes) {
    const dur = scene.actualAudioDurationSeconds ?? scene.durationSeconds;
    const spoken = (scene.narrationText || scene.subtitleText || '').trim();
    const chunks = splitCaptionChunks(spoken, 5);
    if (chunks.length > 0) {
      const step = dur / chunks.length;
      chunks.forEach((chunk, idx) => {
        const start = cursor + idx * step;
        const end = cursor + (idx + 1) * step;
        lines.push(
          `Dialogue: 0,${formatAssTimestamp(start)},${formatAssTimestamp(end)},Default,,0,0,0,,${escapeAssText(chunk)}`
        );
      });
    }
    cursor += dur;
  }

  await fs.writeFile(assPath, header + lines.join('\n') + '\n', 'utf8');
  return assPath;
}

async function renderSceneSegment(params: {
  ffmpegPath: string;
  scene: ScenePlanItem;
  workDir: string;
}): Promise<string> {
  const segPath = path.join(params.workDir, `segment_${params.scene.sceneNumber}.mp4`);
  const dur = Math.max(1.5, params.scene.actualAudioDurationSeconds ?? params.scene.durationSeconds);
  const inputPath = params.scene.assetLocalPath;
  if (!inputPath) {
    throw new Error(`Scene ${params.scene.sceneNumber} is missing a visual media file.`);
  }

  const isVideo = params.scene.assetSource === 'stock_video';

  if (isVideo) {
    // Loop/trim stock video, scale & center-crop to exact 1080x1920 @ 30fps
    await execFileAsync(
      params.ffmpegPath,
      [
        '-y',
        '-stream_loop',
        '-1',
        '-i',
        inputPath,
        '-t',
        dur.toFixed(3),
        '-vf',
        'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,fps=30,format=yuv420p',
        '-an',
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '21',
        segPath,
      ],
      { timeout: 120_000 }
    );
  } else {
    // Animate still image with smooth Ken Burns zoompan at 1080x1920 @ 30fps
    const totalFrames = Math.max(45, Math.round(dur * 30));
    const zoomExpr =
      params.scene.transition === 'zoom'
        ? "min(zoom+0.0014,1.18)"
        : "min(zoom+0.0007,1.10)";
    await execFileAsync(
      params.ffmpegPath,
      [
        '-y',
        '-loop',
        '1',
        '-i',
        inputPath,
        '-vf',
        `scale=1440:2560:force_original_aspect_ratio=increase,crop=1440:2560,zoompan=z='${zoomExpr}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=1080x1920:fps=30,setsar=1,format=yuv420p`,
        '-t',
        dur.toFixed(3),
        '-an',
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '21',
        segPath,
      ],
      { timeout: 120_000 }
    );
  }

  return segPath;
}

async function buildCombinedNarrationTrack(params: {
  ffmpegPath: string;
  scenes: ScenePlanItem[];
  workDir: string;
}): Promise<{ narrationWavPath: string; totalDuration: number; sceneBoundaries: number[] }> {
  const narrationWavPath = path.join(params.workDir, 'combined_narration.wav');
  const concatListPath = path.join(params.workDir, 'audio_concat.txt');

  const lines: string[] = [];
  const boundaries: number[] = [];
  let cursor = 0;

  for (const scene of params.scenes) {
    if (!scene.audioLocalPath) {
      throw new Error(`Scene ${scene.sceneNumber} is missing narration audio.`);
    }
    const dur = Math.max(1.5, scene.actualAudioDurationSeconds ?? scene.durationSeconds);
    if (cursor > 0) boundaries.push(cursor);
    cursor += dur;
    lines.push(`file '${scene.audioLocalPath.replace(/'/g, "'\\''")}'`);
  }

  await fs.writeFile(concatListPath, lines.join('\n') + '\n', 'utf8');

  await execFileAsync(
    params.ffmpegPath,
    [
      '-y',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      concatListPath,
      '-ar',
      '48000',
      '-ac',
      '2',
      '-c:a',
      'pcm_s16le',
      narrationWavPath,
    ],
    { timeout: 60_000 }
  );

  return { narrationWavPath, totalDuration: cursor, sceneBoundaries: boundaries };
}

async function buildSoundtrackAndSfx(params: {
  ffmpegPath: string;
  workDir: string;
  totalDuration: number;
  sceneBoundaries: number[];
  musicMood: string;
}): Promise<string> {
  const mixPath = path.join(params.workDir, 'music_sfx_bed.wav');
  const lowerMood = params.musicMood.toLowerCase();
  const baseFreq = lowerMood.includes('mystery') || lowerMood.includes('dark') ? 110 : 130.81; // A2 or C3 warm pad
  const fifthFreq = Math.round(baseFreq * 1.498 * 100) / 100;

  // Build soft ambient drone bed + subtle whoosh transients at scene boundaries
  const inputs: string[] = [
    '-f',
    'lavfi',
    '-i',
    `aevalsrc='0.35*sin(2*PI*${baseFreq}*t)+0.22*sin(2*PI*${fifthFreq}*t)+0.12*sin(2*PI*${baseFreq * 2}*t)':s=48000:d=${params.totalDuration.toFixed(3)}`,
  ];

  // Add up to 4 subtle transition whoosh cues at scene transitions
  const cueTimes = params.sceneBoundaries.slice(0, 4);
  const filterParts: string[] = [
    `[0:a]lowpass=f=420,volume=0.075,afade=t=in:st=0:d=1.0,afade=t=out:st=${Math.max(0.5, params.totalDuration - 1.2).toFixed(2)}:d=1.2[bed]`,
  ];

  if (cueTimes.length === 0) {
    filterParts.push(`[bed]anull[outa]`);
  } else {
    cueTimes.forEach((boundarySec, idx) => {
      inputs.push(
        '-f',
        'lavfi',
        '-i',
        `anoisesrc=color=pink:sample_rate=48000:duration=0.35`
      );
      const delayMs = Math.max(0, Math.round((boundarySec - 0.15) * 1000));
      filterParts.push(
        `[${idx + 1}:a]bandpass=f=700:width_type=h:w=500,afade=t=in:st=0:d=0.12,afade=t=out:st=0.18:d=0.17,volume=0.16,adelay=${delayMs}|${delayMs}[sfx${idx}]`
      );
    });
    const mixInputs = ['[bed]', ...cueTimes.map((_, i) => `[sfx${i}]`)].join('');
    filterParts.push(`${mixInputs}amix=inputs=${cueTimes.length + 1}:normalize=0[outa]`);
  }

  await execFileAsync(
    params.ffmpegPath,
    [
      '-y',
      ...inputs,
      '-filter_complex',
      filterParts.join(';'),
      '-map',
      '[outa]',
      '-ar',
      '48000',
      '-ac',
      '2',
      '-c:a',
      'pcm_s16le',
      mixPath,
    ],
    { timeout: 60_000 }
  );

  return mixPath;
}

export async function renderFinalMp4(params: {
  videoId: string;
  script: VideoScript;
  subtitleStyle: AppSettings['subtitleStyle'];
}): Promise<{
  mp4Path: string;
  thumbnailPath: string;
  metadata: VerifiedMp4Metadata;
}> {
  const probe = await probeFfmpeg(false);
  if (!probe.available || !probe.path) {
    throw new Error('FFmpeg binary is not installed or unavailable on this server.');
  }

  const workDir = await ensureJobWorkDir(params.videoId);
  const scenes = params.script.scenes;
  if (!scenes.length) {
    throw new Error('Cannot render video with zero scenes.');
  }

  // 1. Render normalized 1080x1920 30fps segments per scene
  const segmentPaths: string[] = [];
  for (const scene of scenes) {
    const seg = await renderSceneSegment({
      ffmpegPath: probe.path,
      scene,
      workDir,
    });
    segmentPaths.push(seg);
  }

  // 2. Concatenate video segments into silent timeline video
  const videoConcatListPath = path.join(workDir, 'video_concat.txt');
  await fs.writeFile(
    videoConcatListPath,
    segmentPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n') + '\n',
    'utf8'
  );
  const rawVideoPath = path.join(workDir, 'timeline_video.mp4');
  await execFileAsync(
    probe.path,
    [
      '-y',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      videoConcatListPath,
      '-c',
      'copy',
      rawVideoPath,
    ],
    { timeout: 60_000 }
  );

  // 3. Build synchronized narration + ambient background music + subtle SFX bed
  const { narrationWavPath, totalDuration, sceneBoundaries } = await buildCombinedNarrationTrack({
    ffmpegPath: probe.path,
    scenes,
    workDir,
  });

  const musicBedPath = await buildSoundtrackAndSfx({
    ffmpegPath: probe.path,
    workDir,
    totalDuration,
    sceneBoundaries,
    musicMood: params.script.musicMood || 'subtle cinematic ambient',
  });

  // 4. Generate synchronized ASS subtitles
  const assPath = await generateAssSubtitles({
    workDir,
    scenes,
    subtitleStyle: params.subtitleStyle,
  });

  // Escape path for FFmpeg ass filter
  const escapedAss = assPath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");

  // 5. Composite video + burned-in subtitles + narration + background music/SFX -> final 1080x1920 MP4
  const finalMp4Path = getFinalMp4Path(params.videoId);
  await execFileAsync(
    probe.path,
    [
      '-y',
      '-i',
      rawVideoPath,
      '-i',
      narrationWavPath,
      '-i',
      musicBedPath,
      '-filter_complex',
      `[0:v]ass='${escapedAss}'[vout];[1:a]volume=1.0[narr];[2:a]volume=1.0[bed];[narr][bed]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95[aout]`,
      '-map',
      '[vout]',
      '-map',
      '[aout]',
      '-c:v',
      'libx264',
      '-preset',
      'medium',
      '-crf',
      '20',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-movflags',
      '+faststart',
      '-shortest',
      finalMp4Path,
    ],
    { timeout: 180_000 }
  );

  // 6. Strictly verify actual MP4 file via ffprobe
  const metadata = await verifyRenderedMp4(finalMp4Path);

  // 7. Extract a real thumbnail JPEG from the rendered MP4
  const thumbnailPath = getThumbnailPath(params.videoId);
  const thumbTimestamp = Math.min(1.5, Math.max(0.2, metadata.durationSeconds * 0.15)).toFixed(2);
  await execFileAsync(
    probe.path,
    [
      '-y',
      '-ss',
      thumbTimestamp,
      '-i',
      finalMp4Path,
      '-vframes',
      '1',
      '-q:v',
      '3',
      thumbnailPath,
    ],
    { timeout: 20_000 }
  );

  // 8. Clean up temporary intermediate render files so Cloud Run disk/memory stays bounded
  const tempFiles = [
    ...segmentPaths,
    rawVideoPath,
    videoConcatListPath,
    narrationWavPath,
    path.join(workDir, 'audio_concat.txt'),
    musicBedPath,
    assPath,
  ];
  await Promise.all(
    tempFiles.map((f) => fs.rm(f, { force: true }).catch(() => undefined))
  );

  return {
    mp4Path: finalMp4Path,
    thumbnailPath,
    metadata,
  };
}
