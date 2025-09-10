import { Router } from 'express';

export function healthRouter() {
  const router = Router();

  router.get('/', (_req, res) => {
    console.log('[HEALTH] Health check requested');
    res.status(200).json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    });
  });

  router.get('/ready', async (_req, res) => {
    // Health check passes without Redis - service is ready if it can respond
    res.json({
      status: 'ready',
      timestamp: new Date().toISOString(),
    });
  });

  return router;
}