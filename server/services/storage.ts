import { Storage } from '@google-cloud/storage';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getServerConfig } from '../config.ts';

export interface StorageHealthResult {
  provider: 'gcs' | 'local_temp';
  status: 'connected' | 'unconfigured';
  bucketName?: string;
  note: string;
}

let storageClient: Storage | null = null;

function getStorageClient(): Storage {
  if (!storageClient) {
    storageClient = new Storage();
  }
  return storageClient;
}

export function getJobWorkDir(videoId: string): string {
  const safeId = videoId.replace(/[^a-zA-Z0-9_-]/g, '');
  const { dataDir } = getServerConfig();
  return path.join(dataDir, 'jobs', safeId);
}

export async function ensureJobWorkDir(videoId: string): Promise<string> {
  const dir = getJobWorkDir(videoId);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export function getFinalMp4Path(videoId: string): string {
  return path.join(getJobWorkDir(videoId), 'final.mp4');
}

export function getThumbnailPath(videoId: string): string {
  return path.join(getJobWorkDir(videoId), 'thumbnail.jpg');
}

export async function checkStorageHealth(): Promise<StorageHealthResult> {
  const { gcsBucketName } = getServerConfig();
  if (!gcsBucketName) {
    return {
      provider: 'local_temp',
      status: 'unconfigured',
      note: 'GCS_BUCKET_NAME is not configured. Using local job storage in dev; set GCS_BUCKET_NAME for permanent Google Cloud Storage in Cloud Run.',
    };
  }

  try {
    const client = getStorageClient();
    const [exists] = await client.bucket(gcsBucketName).exists();
    if (!exists) {
      return {
        provider: 'gcs',
        status: 'unconfigured',
        bucketName: gcsBucketName,
        note: `Configured bucket "${gcsBucketName}" was not found or is not accessible.`,
      };
    }
    return {
      provider: 'gcs',
      status: 'connected',
      bucketName: gcsBucketName,
      note: `Connected to Google Cloud Storage bucket "${gcsBucketName}".`,
    };
  } catch (err) {
    return {
      provider: 'gcs',
      status: 'unconfigured',
      bucketName: gcsBucketName,
      note: err instanceof Error ? `GCS check failed: ${err.message}` : 'GCS connection check failed.',
    };
  }
}

export async function uploadArtifactToGcs(params: {
  localFilePath: string;
  destinationKey: string;
  contentType: string;
}): Promise<{ gcsUri: string; signedUrl?: string } | null> {
  const { gcsBucketName } = getServerConfig();
  if (!gcsBucketName) {
    return null;
  }

  try {
    const client = getStorageClient();
    const bucket = client.bucket(gcsBucketName);
    const [exists] = await bucket.exists();
    if (!exists) {
      console.warn(
        `[Storage] GCS bucket "${gcsBucketName}" does not exist; keeping verified local artifact at ${params.localFilePath}.`
      );
      return null;
    }

    await bucket.upload(params.localFilePath, {
      destination: params.destinationKey,
      contentType: params.contentType,
      resumable: false,
    });

    const gcsUri = `gs://${gcsBucketName}/${params.destinationKey}`;
    let signedUrl: string | undefined;

    try {
      const [url] = await bucket.file(params.destinationKey).getSignedUrl({
        version: 'v4',
        action: 'read',
        expires: Date.now() + 24 * 60 * 60 * 1000,
      });
      signedUrl = url;
    } catch {
      // Signing requires service-account private key or IAM signBlob; server proxy handles streaming/download cleanly
    }

    return { gcsUri, signedUrl };
  } catch (err) {
    console.warn(
      `[Storage] GCS upload skipped for "${params.destinationKey}":`,
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

export async function openGcsReadStream(destinationKey: string) {
  const { gcsBucketName } = getServerConfig();
  if (!gcsBucketName) return null;
  try {
    const client = getStorageClient();
    const file = client.bucket(gcsBucketName).file(destinationKey);
    const [exists] = await file.exists();
    if (!exists) return null;
    const [metadata] = await file.getMetadata();
    return { file, size: Number(metadata.size || 0) };
  } catch {
    return null;
  }
}

export async function deleteJobArtifacts(videoId: string): Promise<void> {
  const dir = getJobWorkDir(videoId);
  await fs.rm(dir, { recursive: true, force: true });

  const { gcsBucketName } = getServerConfig();
  if (gcsBucketName) {
    try {
      const safeId = videoId.replace(/[^a-zA-Z0-9_-]/g, '');
      const client = getStorageClient();
      await client.bucket(gcsBucketName).deleteFiles({ prefix: `videos/${safeId}/` });
    } catch (err) {
      console.warn('[Storage] Failed to delete GCS prefix:', err);
    }
  }
}
