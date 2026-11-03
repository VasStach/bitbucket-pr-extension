import type { Comment } from '../bitbucket/types';

/** True for BLOCKER comments ("tasks"). Tasks block the merge until resolved. */
export function isTask(c: Comment): boolean {
  return c.severity === 'BLOCKER';
}

/** A task that has not been completed yet. */
export function isOpenTask(c: Comment): boolean {
  return isTask(c) && c.state !== 'RESOLVED';
}

/** A completed task. */
export function isResolvedTask(c: Comment): boolean {
  return isTask(c) && c.state === 'RESOLVED';
}

/**
 * Thread-level "resolved" display state. Only tasks are actively resolved from the IDE;
 * a plain comment thread counts as resolved only when it was resolved on the server (DC 8.9+ `threadResolved`).
 */
export function isResolved(c: Comment): boolean {
  return isTask(c) ? c.state === 'RESOLVED' : c.threadResolved === true;
}

export function isUnresolved(c: Comment): boolean {
  return !isResolved(c);
}

/** Walks a comment tree (root and all replies). */
export function* walkComments(root: Comment): Generator<Comment> {
  yield root;
  for (const child of root.comments ?? []) {
    yield* walkComments(child);
  }
}

/** Counts tasks in a thread tree (root and replies). */
export function countTasks(roots: Comment[]): { open: number; total: number } {
  let open = 0;
  let total = 0;
  for (const root of roots) {
    for (const c of walkComments(root)) {
      if (isTask(c)) {
        total++;
        if (isOpenTask(c)) {
          open++;
        }
      }
    }
  }
  return { open, total };
}
