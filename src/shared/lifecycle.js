/**
 * Process lifecycle state.
 *
 * Deliberately process-local: this is the one kind of in-memory state that is
 * correct to keep per-instance, because it describes *this* Node process, not
 * shared application state. Nothing here prevents running many instances.
 */
let shuttingDown = false;

/** True once SIGINT/SIGTERM has been received and drain has started. */
export const isShuttingDown = () => shuttingDown;

/** Idempotent. Returns false if shutdown was already in progress. */
export const beginShutdown = () => {
  if (shuttingDown) return false;
  shuttingDown = true;
  return true;
};
