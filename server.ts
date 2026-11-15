import 'dotenv/config';
import cookieParser from 'cookie-parser';
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getServerConfig } from './server/config.ts';
import { createApiRouter } from './server/routes/api.ts';
import { probeFfmpeg } from './server/services/ffmpeg.ts';
import { getFirebaseAdminApp } from './server/services/firebaseAdmin.ts';
import { initStore } from './server/services/store.ts';

async function startServer() {
  const config = getServerConfig();

  // Initialize persistence store, Firebase Admin verifier, and FFmpeg availability check on startup
  await initStore();
  getFirebaseAdminApp();

  const ffmpegStatus = await probeFfmpeg(true);
  if (ffmpegStatus.available) {
    console.log(
      `[ShortForge] FFmpeg detected at ${ffmpegStatus.path} (version ${ffmpegStatus.version})`
    );
  } else {
    console.warn(`[ShortForge] FFmpeg not available: ${ffmpegStatus.error}`);
  }

  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-XSS-Protection', '0');
    next();
  });

  app.use(cookieParser());
  app.use(express.json({ limit: '1mb' }));

  // Mount API routes
  app.use('/api', createApiRouter());

  // Safe error handler for API routes (never leak stack traces or environment secrets)
  app.use(
    (
      err: unknown,
      req: express.Request,
      res: express.Response,
      next: express.NextFunction
    ) => {
      if (req.path.startsWith('/api')) {
        const status =
          err && typeof err === 'object' && 'status' in err && typeof err.status === 'number'
            ? err.status
            : 500;
        if (status === 400 && err instanceof SyntaxError) {
          res.status(400).json({
            error: {
              code: 'INVALID_JSON',
              message: 'Malformed JSON request body.',
              retryable: false,
            },
          });
          return;
        }
        console.error('[API Error]', err instanceof Error ? err.message : 'Unexpected server error');
        res.status(status >= 400 && status < 600 ? status : 500).json({
          error: {
            code: 'INTERNAL_SERVER_ERROR',
            message: 'An unexpected server error occurred. Check server diagnostics.',
            retryable: false,
          },
        });
        return;
      }
      next(err);
    }
  );

  if (config.nodeEnv !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', async (_req, res, next) => {
      try {
        const indexPath = path.join(distDir, 'index.html');
        await fs.access(indexPath);
        res.sendFile(indexPath);
      } catch (err) {
        next(err);
      }
    });
  }

  app.listen(config.port, '0.0.0.0', () => {
    console.log(`[ShortForge] Server listening on http://0.0.0.0:${config.port} (${config.nodeEnv})`);
  });
}

startServer().catch((err) => {
  console.error('[ShortForge] Fatal startup error:', err);
  process.exit(1);
});
