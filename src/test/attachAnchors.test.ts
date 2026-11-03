import * as assert from 'node:assert';
import type { Comment, CommentAnchor, FileDiff } from '../bitbucket/types';
import { attachAnchors } from '../core/attachAnchors';

function comment(id: number, anchor?: CommentAnchor): Comment {
  return { id, version: 0, text: 't', author: { name: 'a', displayName: 'A', slug: 'a', id: 1 }, createdDate: id, updatedDate: id, comments: [], anchor };
}

const diff: FileDiff = {
  source: { components: ['f'], name: 'f', toString: 'f' },
  destination: { components: ['f'], name: 'f', toString: 'f' },
  hunks: [
    {
      sourceLine: 50,
      sourceSpan: 4,
      destinationLine: 60,
      destinationSpan: 5,
      segments: [
        { type: 'CONTEXT', lines: [{ source: 50, destination: 60, line: 'a', commentIds: [1] }] },
        { type: 'REMOVED', lines: [{ source: 51, destination: 61, line: 'b', commentIds: [2] }] },
        { type: 'ADDED', lines: [{ source: 52, destination: 61, line: 'c', commentIds: [3, 4] }, { source: 52, destination: 62, line: 'd' }] },
        { type: 'CONTEXT', lines: [{ source: 52, destination: 63, line: 'e', commentIds: [5] }] },
      ],
    },
  ],
};

describe('attachAnchors', () => {
  it('rebuilds anchors from commentIds on diff lines', () => {
    const comments = [comment(1), comment(2), comment(3), comment(4), comment(6)];
    attachAnchors(comments, diff, 'f', undefined, new Map());
    assert.deepStrictEqual(comments[0].anchor, { path: 'f', srcPath: undefined, lineType: 'CONTEXT', fileType: 'TO', line: 60, diffType: 'EFFECTIVE', multilineMarker: undefined });
    assert.deepStrictEqual(comments[1].anchor, { path: 'f', srcPath: undefined, lineType: 'REMOVED', fileType: 'FROM', line: 51, diffType: 'EFFECTIVE', multilineMarker: undefined });
    assert.strictEqual(comments[2].anchor?.line, 61);
    assert.strictEqual(comments[2].anchor?.lineType, 'ADDED');
    assert.strictEqual(comments[3].anchor?.line, 61);
    assert.strictEqual(comments[4].anchor?.orphaned, true, 'comments not present on any line are marked orphaned');
  });

  it('uses the activity anchor to pick the side of CONTEXT comments', () => {
    const comments = [comment(5)];
    const known = new Map<number, CommentAnchor>([[5, { path: 'f', line: 52, lineType: 'CONTEXT', fileType: 'FROM' }]]);
    attachAnchors(comments, diff, 'f', undefined, known);
    assert.strictEqual(comments[0].anchor?.fileType, 'FROM');
    assert.strictEqual(comments[0].anchor?.line, 52, 'FROM-side context anchors use the source line number');
  });

  it('falls back to the activity anchor when the line is not in the hunks', () => {
    const comments = [comment(7)];
    const known = new Map<number, CommentAnchor>([[7, { path: 'f', line: 5, lineType: 'CONTEXT', fileType: 'TO' }]]);
    attachAnchors(comments, diff, 'f', undefined, known);
    assert.strictEqual(comments[0].anchor?.line, 5);
  });

  it('keeps anchors that the server already provided', () => {
    const provided: CommentAnchor = { path: 'f', line: 99, lineType: 'ADDED', fileType: 'TO' };
    const comments = [comment(1, provided)];
    attachAnchors(comments, diff, 'f', undefined, new Map());
    assert.strictEqual(comments[0].anchor, provided);
  });
});
