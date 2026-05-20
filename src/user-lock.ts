/**
 * Per-user mutex: serialise Sheets/FSM writes for the same Telegram user_id.
 */

const userLocks = new Map<number, Promise<unknown>>();

export function withUserLock<T>(userId: number, fn: () => Promise<T>): Promise<T> {
  const prev = userLocks.get(userId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  userLocks.set(userId, next);
  next.finally(() => {
    if (userLocks.get(userId) === next) userLocks.delete(userId);
  });
  return next;
}
