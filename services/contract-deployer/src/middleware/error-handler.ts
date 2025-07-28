import { Request, Response, NextFunction } from 'express';
import { createLogger } from '../utils/logger';

const logger = createLogger('error');

export class AppError extends Error {
  constructor(
    public statusCode: number,
    public message: string,
    public code?: string,
  ) {
    super(message);
    Object.setPrototypeOf(this, AppError.prototype);
  }
}

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const error = err as AppError;
  const statusCode = error.statusCode || 500;

  logger.error({
    error: err,
    request: req.url,
    method: req.method,
    ip: req.ip,
    stack: err.stack,
  });

  res.status(statusCode).json({
    error: {
      code: error.code || 'INTERNAL_ERROR',
      message: statusCode === 500 ? 'Internal server error' : error.message,
      ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
    },
  });
}