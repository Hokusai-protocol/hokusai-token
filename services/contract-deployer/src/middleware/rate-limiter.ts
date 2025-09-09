import rateLimit from 'express-rate-limit';

export function rateLimiter(windowMs: number, maxRequests: number) {
  return rateLimit({
    windowMs,
    max: maxRequests,
    message: 'Too many requests from this IP, please try again later.',
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).json({
        error: {
          code: 'RATE_LIMIT_EXCEEDED',
          message: 'Too many requests',
        },
      });
    },
  });
}