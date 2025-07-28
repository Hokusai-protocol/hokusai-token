import { Router } from 'express';
import { QueueService } from '../services/queue.service';
import { BlockchainService } from '../services/blockchain.service';

export function deploymentRouter(
  queueService: QueueService,
  blockchainService: BlockchainService,
): Router {
  const router = Router();

  // TODO: Implement deployment endpoints
  router.post('/', async (req, res) => {
    res.status(501).json({ error: 'Not implemented' });
  });

  router.get('/:id', async (req, res) => {
    res.status(501).json({ error: 'Not implemented' });
  });

  return router;
}