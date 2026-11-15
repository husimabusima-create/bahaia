import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import type express from 'express';

function rateLimitKeyGenerator(req: express.Request): string {
  if (req.authUser?.uid) {
    return `uid:${req.authUser.uid}`;
  }
  const ip = req.ip || req.socket.remoteAddress || '127.0.0.1';
  return `ip:${ipKeyGenerator(ip)}`;
}

function buildRateLimitHandler(message: string) {
  return (_req: express.Request, res: express.Response) => {
    res.status(429).json({
      error: {
        code: 'RATE_LIMIT_EXCEEDED',
        message,
        retryable: true,
      },
    });
  };
}

function readLimitEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

export const apiGeneralLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: readLimitEnv('RATE_LIMIT_GENERAL_MAX', 240),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: rateLimitKeyGenerator,
  handler: buildRateLimitHandler('Too many API requests. Please wait a minute and retry.'),
});

export const authSessionLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: readLimitEnv('RATE_LIMIT_AUTH_MAX', 40),
  standardHeaders: true,
  legacyHeaders: false,
  handler: buildRateLimitHandler('Too many authentication attempts. Please wait and try again.'),
});

export const aiGenerationLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: readLimitEnv('RATE_LIMIT_AI_MAX', 10),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: rateLimitKeyGenerator,
  handler: buildRateLimitHandler(
    'AI generation rate limit reached (max 10 topic/script requests per minute). Wait before retrying.'
  ),
});

export const renderPipelineLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: readLimitEnv('RATE_LIMIT_RENDER_MAX', 8),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: rateLimitKeyGenerator,
  handler: buildRateLimitHandler(
    'Video render rate limit reached. Wait a few minutes before starting another render.'
  ),
});
