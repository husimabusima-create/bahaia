import path from 'node:path';

export interface ServerConfig {
  port: number;
  nodeEnv: string;
  appUrl: string;
  geminiApiKey: string;
  gcsBucketName: string;
  pexelsApiKey: string;
  pixabayApiKey: string;
  schedulerSecret: string;
  dataDir: string;
}

export function getServerConfig(): ServerConfig {
  const parsedPort = Number(process.env.PORT || '3000');
  return {
    port: Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 3000,
    nodeEnv: process.env.NODE_ENV || 'development',
    appUrl: process.env.APP_URL || '',
    geminiApiKey: (process.env.GEMINI_API_KEY || '').trim(),
    gcsBucketName: (process.env.GCS_BUCKET_NAME || '').trim(),
    pexelsApiKey: (process.env.PEXELS_API_KEY || '').trim(),
    pixabayApiKey: (process.env.PIXABAY_API_KEY || '').trim(),
    schedulerSecret: (process.env.SCHEDULER_SECRET || '').trim(),
    dataDir: process.env.DATA_DIR
      ? path.resolve(process.env.DATA_DIR)
      : path.resolve(process.cwd(), 'data'),
  };
}
