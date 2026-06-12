import express from 'express';
import request from 'supertest';
import { asyncHandler } from '../../../src/middleware/async-handler';

describe('asyncHandler', () => {
  test('passes successful responses through', async () => {
    const app = express();

    app.get(
      '/ok',
      asyncHandler(async (_req, res) => {
        await Promise.resolve();
        res.status(204).end();
      }),
    );

    const response = await request(app).get('/ok');

    expect(response.status).toBe(204);
  });

  test('forwards async rejections to express error middleware', async () => {
    const app = express();

    app.get(
      '/fail',
      asyncHandler(async () => {
        await Promise.resolve();
        throw new Error('boom');
      }),
    );
    app.use(
      (error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        res.status(500).json({ message: error.message });
      },
    );

    const response = await request(app).get('/fail');

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ message: 'boom' });
  });

  test('forwards synchronous throws inside async handlers', async () => {
    const app = express();

    app.get(
      '/sync-fail',
      asyncHandler(async () => {
        await Promise.resolve();
        throw new TypeError('sync boom');
      }),
    );
    app.use(
      (error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        res.status(500).json({ message: error.message });
      },
    );

    const response = await request(app).get('/sync-fail');

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ message: 'sync boom' });
  });
});
