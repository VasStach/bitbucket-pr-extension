import type { CommentAnchor, DiffHunk, FileDiff, FileType, LineType } from '../bitbucket/types';

/** Side of a diff: FROM = target/old version (left), TO = source/new version (right, matches local file). */
export type Side = FileType;

export interface AnchorSpec {
  /** 1-based line number in the file given by fileType. */
  line: number;
  lineType: LineType;
  fileType: FileType;
}

export interface MappedPosition {
  /** 1-based line on the FROM (left) side, when the anchored line exists there. */
  from?: number;
  /** 1-based line on the TO (right / local) side, when the anchored line exists there. */
  to?: number;
  /**
   * The line on the TO side where a REMOVED-line comment should be displayed
   * (the destination position of the removal). Approximate; set only for REMOVED anchors.
   */
  toApprox?: number;
}

interface LineInfo {
  type: LineType;
  source: number;
  destination: number;
}

function* iterateLines(hunks: DiffHunk[] | undefined): Generator<LineInfo> {
  for (const hunk of hunks ?? []) {
    for (const seg of hunk.segments ?? []) {
      for (const l of seg.lines ?? []) {
        yield { type: seg.type, source: l.source, destination: l.destination };
      }
    }
  }
}

/** Finds the diff line at `line` on `side` inside the hunks (exact match only). */
export function findDiffLine(diff: FileDiff | undefined, side: Side, line: number): LineInfo | undefined {
  for (const info of iterateLines(diff?.hunks)) {
    if (side === 'TO') {
      if (info.type !== 'REMOVED' && info.destination === line) {
        return info;
      }
    } else if (info.type !== 'ADDED' && info.source === line) {
      return info;
    }
  }
  return undefined;
}

/**
 * Maps a line number from one side to the other for lines *outside* the hunks (unchanged regions),
 * using the cumulative offset of preceding hunks. Returns undefined when the line falls inside a
 * changed region but is not present in the hunks (should not happen with full hunks).
 */
export function mapUnchangedLine(diff: FileDiff | undefined, side: Side, line: number): number | undefined {
  let delta = 0; // destination - source for the gap after the previously processed hunk
  const hunks = (diff?.hunks ?? []).slice().sort((a, b) => a.sourceLine - b.sourceLine);
  for (const hunk of hunks) {
    const hunkStart = side === 'TO' ? hunk.destinationLine : hunk.sourceLine;
    const hunkSpan = side === 'TO' ? hunk.destinationSpan : hunk.sourceSpan;
    if (line < hunkStart) {
      return side === 'TO' ? line - delta : line + delta;
    }
    if (line < hunkStart + hunkSpan) {
      // Inside a hunk: use exact mapping of context lines.
      const info = findDiffLine(diff, side, line);
      if (!info || info.type !== 'CONTEXT') {
        return undefined;
      }
      return side === 'TO' ? info.source : info.destination;
    }
    delta = hunk.destinationLine + hunk.destinationSpan - (hunk.sourceLine + hunk.sourceSpan);
  }
  return side === 'TO' ? line - delta : line + delta;
}

/**
 * Converts an editor line (1-based) on a given side into a Bitbucket comment anchor.
 * Lines inside hunks get the exact segment type; lines outside hunks are CONTEXT lines on that side.
 */
export function positionToAnchor(diff: FileDiff | undefined, side: Side, line: number): AnchorSpec | undefined {
  if (line < 1) {
    return undefined;
  }
  const info = findDiffLine(diff, side, line);
  if (info) {
    switch (info.type) {
      case 'ADDED':
        return { line: info.destination, lineType: 'ADDED', fileType: 'TO' };
      case 'REMOVED':
        return { line: info.source, lineType: 'REMOVED', fileType: 'FROM' };
      case 'CONTEXT':
        return { line, lineType: 'CONTEXT', fileType: side };
    }
  }
  // Outside hunks: the line is unchanged. For deleted files nothing exists on TO; for added files nothing on FROM.
  if (diff && side === 'TO' && diff.destination == null) {
    return undefined;
  }
  if (diff && side === 'FROM' && diff.source == null) {
    return undefined;
  }
  return { line, lineType: 'CONTEXT', fileType: side };
}

/** Converts a Bitbucket anchor into line numbers on both sides where the line exists. */
export function anchorToPositions(diff: FileDiff | undefined, anchor: CommentAnchor | AnchorSpec): MappedPosition {
  const line = anchor.line;
  if (line === undefined || line === null) {
    return {};
  }
  const lineType = anchor.lineType ?? 'CONTEXT';
  const fileType = anchor.fileType ?? (lineType === 'REMOVED' ? 'FROM' : 'TO');

  if (lineType === 'ADDED') {
    return { to: line };
  }
  if (lineType === 'REMOVED') {
    const info = findDiffLine(diff, 'FROM', line);
    const toApprox = info ? Math.max(1, info.destination) : undefined;
    return { from: line, toApprox };
  }
  // CONTEXT: present on both sides.
  if (fileType === 'TO') {
    const info = findDiffLine(diff, 'TO', line);
    const from = info?.type === 'CONTEXT' ? info.source : mapUnchangedLine(diff, 'TO', line);
    return { to: line, from: from ?? undefined };
  }
  const info = findDiffLine(diff, 'FROM', line);
  const to = info?.type === 'CONTEXT' ? info.destination : mapUnchangedLine(diff, 'FROM', line);
  return { from: line, to: to ?? undefined };
}

/** Display line on a given side for an anchor, falling back to the approximate position for REMOVED lines on TO. */
export function displayLine(diff: FileDiff | undefined, anchor: CommentAnchor | AnchorSpec, side: Side): { line: number; approximate: boolean } | undefined {
  const pos = anchorToPositions(diff, anchor);
  if (side === 'FROM') {
    return pos.from !== undefined ? { line: pos.from, approximate: false } : undefined;
  }
  if (pos.to !== undefined) {
    return { line: pos.to, approximate: false };
  }
  if (pos.toApprox !== undefined) {
    return { line: pos.toApprox, approximate: true };
  }
  return undefined;
}

/** Start line (on the same side as `anchor`) of a multi-line comment, or the anchor line itself. */
export function anchorStartLine(anchor: CommentAnchor): number | undefined {
  const marker = anchor.multilineMarker;
  if (marker && marker.startLine && anchor.line !== undefined && marker.startLine <= anchor.line) {
    return marker.startLine;
  }
  return anchor.line;
}

/** Human-readable description of an anchor, e.g. "line 42 (removed)". */
export function describeAnchor(anchor: CommentAnchor): string {
  const kind = anchor.lineType === 'ADDED' ? 'added' : anchor.lineType === 'REMOVED' ? 'removed' : 'context';
  const side = anchor.fileType === 'FROM' ? 'target' : 'source';
  return `line ${anchor.line ?? '?'} (${kind}, ${side} side)`;
}
