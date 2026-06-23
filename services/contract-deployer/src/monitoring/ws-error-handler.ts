/**
 * Attach an error handler to an ethers WebSocketProvider's underlying socket.
 *
 * Root cause of the relayer/monitor crash-loop (B2): ethers v6 `WebSocketProvider` does not register
 * an `error` listener on its underlying socket. On Node the `ws` library throws an *uncaught* error
 * when the socket drops; with no surviving listener that terminates the whole process (exit code 1).
 * Because the AMM monitor runs in-process with the mint relayer, an Alchemy WebSocket hiccup was
 * silently killing the money path after a variable interval.
 *
 * Attaching a handler converts that fatal, unhandled error into a logged, survived one — the
 * ingestion heartbeat then fails over to the backup/HTTP provider on its next tick.
 *
 * Kept as a pure helper (socket injected) so it can be unit-tested without standing up a real
 * WebSocket. Supports both the Node `ws` event API (`.on('error')`) and the browser-style
 * `onerror` property, preserving any pre-existing `onerror` handler.
 */
export interface SocketLike {
  on?: (event: string, cb: (err: unknown) => void) => void;
  onerror?: ((err: unknown) => void) | null;
}

export function attachSocketErrorHandler(
  socket: SocketLike | null | undefined,
  onError: (err: unknown) => void,
): boolean {
  if (!socket) {
    return false;
  }
  if (typeof socket.on === 'function') {
    socket.on('error', onError);
    return true;
  }
  const previous = socket.onerror;
  socket.onerror = (err: unknown) => {
    onError(err);
    if (typeof previous === 'function') {
      previous(err);
    }
  };
  return true;
}
