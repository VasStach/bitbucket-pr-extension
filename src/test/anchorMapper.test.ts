import * as assert from 'node:assert';
import type { FileDiff } from '../bitbucket/types';
import { anchorToPositions, displayLine, mapUnchangedLine, positionToAnchor } from '../core/anchorMapper';

/**
 * Source (FROM)      Destination (TO)
 * 1 a                1 a
 * 2 b                2 b
 * 3 c   (removed)    3 X   (added)
 * 4 d                4 d
 * 5 e                5 e
 * 6 f                6 f
 * ...                ...
 * 10 j               10 j
 *                    11 Y  (added)
 *                    12 Z  (added)
 * 11 k               13 k
 * 12 l               14 l
 */
const diff: FileDiff = {
  source: { components: ['a.txt'], name: 'a.txt', toString: 'a.txt' },
  destination: { components: ['a.txt'], name: 'a.txt', toString: 'a.txt' },
  hunks: [
    {
      sourceLine: 1,
      sourceSpan: 5,
      destinationLine: 1,
      destinationSpan: 5,
      segments: [
        { type: 'CONTEXT', lines: [{ source: 1, destination: 1, line: 'a' }, { source: 2, destination: 2, line: 'b' }] },
        { type: 'REMOVED', lines: [{ source: 3, destination: 3, line: 'c' }] },
        { type: 'ADDED', lines: [{ source: 4, destination: 3, line: 'X' }] },
        { type: 'CONTEXT', lines: [{ source: 4, destination: 4, line: 'd' }, { source: 5, destination: 5, line: 'e' }] },
      ],
    },
    {
      sourceLine: 9,
      sourceSpan: 4,
      destinationLine: 9,
      destinationSpan: 6,
      segments: [
        { type: 'CONTEXT', lines: [{ source: 9, destination: 9, line: 'i' }, { source: 10, destination: 10, line: 'j' }] },
        { type: 'ADDED', lines: [{ source: 11, destination: 11, line: 'Y' }, { source: 11, destination: 12, line: 'Z' }] },
        { type: 'CONTEXT', lines: [{ source: 11, destination: 13, line: 'k' }, { source: 12, destination: 14, line: 'l' }] },
      ],
    },
  ],
};

describe('anchorMapper.positionToAnchor', () => {
  it('maps an added line on the TO side', () => {
    assert.deepStrictEqual(positionToAnchor(diff, 'TO', 3), { line: 3, lineType: 'ADDED', fileType: 'TO' });
    assert.deepStrictEqual(positionToAnchor(diff, 'TO', 12), { line: 12, lineType: 'ADDED', fileType: 'TO' });
  });

  it('maps a removed line on the FROM side', () => {
    assert.deepStrictEqual(positionToAnchor(diff, 'FROM', 3), { line: 3, lineType: 'REMOVED', fileType: 'FROM' });
  });

  it('maps context lines inside hunks on either side', () => {
    assert.deepStrictEqual(positionToAnchor(diff, 'TO', 13), { line: 13, lineType: 'CONTEXT', fileType: 'TO' });
    assert.deepStrictEqual(positionToAnchor(diff, 'FROM', 11), { line: 11, lineType: 'CONTEXT', fileType: 'FROM' });
  });

  it('maps lines outside hunks as CONTEXT on the given side', () => {
    assert.deepStrictEqual(positionToAnchor(diff, 'TO', 7), { line: 7, lineType: 'CONTEXT', fileType: 'TO' });
    assert.deepStrictEqual(positionToAnchor(diff, 'FROM', 7), { line: 7, lineType: 'CONTEXT', fileType: 'FROM' });
    assert.deepStrictEqual(positionToAnchor(diff, 'TO', 100), { line: 100, lineType: 'CONTEXT', fileType: 'TO' });
  });

  it('refuses positions on a side that does not exist (added / deleted files)', () => {
    const added: FileDiff = { ...diff, source: null };
    assert.strictEqual(positionToAnchor(added, 'FROM', 7), undefined);
    const deleted: FileDiff = { ...diff, destination: null };
    assert.strictEqual(positionToAnchor(deleted, 'TO', 7), undefined);
  });

  it('rejects line numbers below 1', () => {
    assert.strictEqual(positionToAnchor(diff, 'TO', 0), undefined);
  });
});

describe('anchorMapper.mapUnchangedLine', () => {
  it('returns identity before the first change', () => {
    assert.strictEqual(mapUnchangedLine(diff, 'TO', 1), 1);
    assert.strictEqual(mapUnchangedLine(diff, 'FROM', 2), 2);
  });

  it('applies the cumulative offset between and after hunks', () => {
    assert.strictEqual(mapUnchangedLine(diff, 'TO', 7), 7); // first hunk is balanced (1 removed, 1 added)
    assert.strictEqual(mapUnchangedLine(diff, 'TO', 20), 18); // +2 after second hunk
    assert.strictEqual(mapUnchangedLine(diff, 'FROM', 18), 20);
  });

  it('maps context lines inside hunks exactly', () => {
    assert.strictEqual(mapUnchangedLine(diff, 'TO', 13), 11);
    assert.strictEqual(mapUnchangedLine(diff, 'FROM', 12), 14);
  });

  it('returns undefined for changed lines inside hunks', () => {
    assert.strictEqual(mapUnchangedLine(diff, 'TO', 11), undefined);
    assert.strictEqual(mapUnchangedLine(diff, 'FROM', 3), undefined);
  });
});

describe('anchorMapper.anchorToPositions', () => {
  it('places ADDED anchors on the TO side only', () => {
    assert.deepStrictEqual(anchorToPositions(diff, { path: 'a.txt', line: 11, lineType: 'ADDED', fileType: 'TO' }), { to: 11 });
  });

  it('places REMOVED anchors on FROM with an approximate TO position', () => {
    assert.deepStrictEqual(anchorToPositions(diff, { path: 'a.txt', line: 3, lineType: 'REMOVED', fileType: 'FROM' }), { from: 3, toApprox: 3 });
  });

  it('maps CONTEXT anchors to both sides', () => {
    assert.deepStrictEqual(anchorToPositions(diff, { path: 'a.txt', line: 13, lineType: 'CONTEXT', fileType: 'TO' }), { to: 13, from: 11 });
    assert.deepStrictEqual(anchorToPositions(diff, { path: 'a.txt', line: 11, lineType: 'CONTEXT', fileType: 'FROM' }), { from: 11, to: 13 });
    assert.deepStrictEqual(anchorToPositions(diff, { path: 'a.txt', line: 20, lineType: 'CONTEXT', fileType: 'FROM' }), { from: 20, to: 22 });
  });

  it('handles anchors without a line (file-level comments)', () => {
    assert.deepStrictEqual(anchorToPositions(diff, { path: 'a.txt' }), {});
  });
});

describe('anchorMapper.displayLine', () => {
  it('uses the approximate TO position for removed lines', () => {
    assert.deepStrictEqual(displayLine(diff, { path: 'a.txt', line: 3, lineType: 'REMOVED', fileType: 'FROM' }, 'TO'), { line: 3, approximate: true });
    assert.deepStrictEqual(displayLine(diff, { path: 'a.txt', line: 3, lineType: 'REMOVED', fileType: 'FROM' }, 'FROM'), { line: 3, approximate: false });
  });

  it('returns undefined for added lines on the FROM side', () => {
    assert.strictEqual(displayLine(diff, { path: 'a.txt', line: 11, lineType: 'ADDED', fileType: 'TO' }, 'FROM'), undefined);
  });
});
