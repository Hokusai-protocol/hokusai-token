import type { Logger } from 'winston';

/**
 * Install global unhandledRejection / uncaughtException handlers.
 *
 * Why this exists (HOK B2): the previous handlers called `logger.error(...)` then *immediately*
 * `process.exit(1)`. winston's transports flush asynchronously, so the error never reached CloudWatch
 * before the process died — every crash looked causeless ("Essential container in task exited",
 * exit 1, no log). These handlers write the cause synchronously to stderr first (which survives an
 * imminent exit far more reliably than a buffered winston write), also log structured via winston,
 * then defer the exit briefly so the async transport can flush.
 *
 * The process still exits — an uncaught exception leaves the process in an unknown state — but now
 * the reason is captured. The actual remedy for the known WebSocket crash is the socket error
 * handler in monitoring/ws-error-handler.ts; this is the safety net for anything else.
 *
 * @param flushMs delay before exit so logs can flush (overridable for tests).
 */
export function installGlobalErrorHandlers(logger: Logger, flushMs = 500): void {
  process.on('unhandledRejection', (reason: unknown) => {
    // eslint-disable-next-line no-console -- synchronous stderr capture; survives the pending exit
    console.error('[FATAL] Unhandled Rejection:', reason instanceof Error ? reason.stack : reason);
    logger.error('Unhandled Rejection', {
      reason: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    });
    const timer = setTimeout(() => process.exit(1), flushMs);
    timer.unref?.();
  });

  process.on('uncaughtException', (error: Error) => {
    // eslint-disable-next-line no-console -- synchronous stderr capture; survives the pending exit
    console.error('[FATAL] Uncaught Exception:', error.stack ?? error);
    logger.error('Uncaught Exception', { error: error.message, stack: error.stack });
    const timer = setTimeout(() => process.exit(1), flushMs);
    timer.unref?.();
  });
}
