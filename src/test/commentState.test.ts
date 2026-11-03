import * as assert from 'node:assert';
import type { Comment } from '../bitbucket/types';
import { countTasks, isOpenTask, isResolved, isTask } from '../core/commentState';

function c(partial: Partial<Comment>): Comment {
  return { id: 1, version: 0, text: '', author: { name: 'a', displayName: 'A', slug: 'a', id: 1 }, createdDate: 0, updatedDate: 0, comments: [], ...partial };
}

describe('commentState', () => {
  it('identifies tasks by BLOCKER severity', () => {
    assert.strictEqual(isTask(c({ severity: 'BLOCKER' })), true);
    assert.strictEqual(isTask(c({ severity: 'NORMAL' })), false);
    assert.strictEqual(isTask(c({})), false);
  });

  it('tracks task completion through state (Bitbucket 8.19 keeps threadResolved=false for tasks)', () => {
    assert.strictEqual(isOpenTask(c({ severity: 'BLOCKER', state: 'OPEN', threadResolved: false })), true);
    assert.strictEqual(isOpenTask(c({ severity: 'BLOCKER', state: 'RESOLVED', threadResolved: false })), false);
    assert.strictEqual(isResolved(c({ severity: 'BLOCKER', state: 'RESOLVED' })), true);
  });

  it('plain comments are never open tasks; thread resolution from the server is display-only', () => {
    assert.strictEqual(isOpenTask(c({ state: 'OPEN' })), false);
    assert.strictEqual(isResolved(c({ threadResolved: true })), true);
    assert.strictEqual(isResolved(c({ state: 'OPEN' })), false);
  });

  it('counts tasks in roots and replies', () => {
    const roots = [
      c({ id: 1, severity: 'BLOCKER', state: 'OPEN', comments: [c({ id: 2, severity: 'BLOCKER', state: 'RESOLVED' }), c({ id: 3 })] }),
      c({ id: 4, comments: [c({ id: 5, severity: 'BLOCKER', state: 'OPEN' })] }),
    ];
    assert.deepStrictEqual(countTasks(roots), { open: 2, total: 3 });
  });
});
