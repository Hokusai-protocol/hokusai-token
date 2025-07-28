import { Router } from 'express';

export const healthRouter = Router();

healthRouter.get('/', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

healthRouter.get('/ready', async (req, res) => {
  // TODO: Add readiness checks (Redis connection, blockchain connection)
  res.json({
    status: 'ready',
    timestamp: new Date().toISOString(),
  });
});