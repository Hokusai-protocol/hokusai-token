import { attachSocketErrorHandler, SocketLike } from '../../../src/monitoring/ws-error-handler';

describe('attachSocketErrorHandler (HOK B2 crash-loop fix)', () => {
  it('registers an error listener on a Node ws-style socket (.on)', () => {
    const listeners: Record<string, (err: unknown) => void> = {};
    const socket: SocketLike = {
      on: (event, cb) => {
        listeners[event] = cb;
      },
    };
    const seen: unknown[] = [];
    const ok = attachSocketErrorHandler(socket, (err) => seen.push(err));

    expect(ok).toBe(true);
    expect(typeof listeners.error).toBe('function');
    listeners.error?.(new Error('socket dropped'));
    expect(seen).toHaveLength(1);
    expect((seen[0] as Error).message).toBe('socket dropped');
  });

  it('falls back to onerror and preserves a pre-existing handler', () => {
    const prevCalls: unknown[] = [];
    const socket: SocketLike = {
      onerror: (err) => prevCalls.push(err),
    };
    const seen: unknown[] = [];
    const ok = attachSocketErrorHandler(socket, (err) => seen.push(err));

    expect(ok).toBe(true);
    const err = new Error('boom');
    socket.onerror?.(err);
    // our handler runs AND the previous one is still invoked
    expect(seen).toEqual([err]);
    expect(prevCalls).toEqual([err]);
  });

  it('returns false when the socket is unavailable', () => {
    expect(attachSocketErrorHandler(null, () => undefined)).toBe(false);
    expect(attachSocketErrorHandler(undefined, () => undefined)).toBe(false);
  });
});
