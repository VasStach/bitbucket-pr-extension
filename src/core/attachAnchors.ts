import type { Comment, CommentAnchor, FileDiff, FileType, LineType } from '../bitbucket/types';

/**
 * The PR diff endpoint returns `lineComments` without `anchor`; the line each comment belongs to is
 * given by `commentIds` on the diff lines. Rebuild anchors from the segments, preferring the anchor
 * recorded in the activity stream (which also knows the side of CONTEXT comments).
 */
export function attachAnchors(comments: Comment[], diff: FileDiff, path: string, srcPath: string | undefined, known: Map<number, CommentAnchor>): void {
  const byLine = new Map<number, { type: LineType; source: number; destination: number }>();
  for (const hunk of diff.hunks ?? []) {
    for (const seg of hunk.segments ?? []) {
      for (const line of seg.lines ?? []) {
        for (const id of line.commentIds ?? []) {
          byLine.set(id, { type: seg.type, source: line.source, destination: line.destination });
        }
      }
    }
  }
  for (const c of comments) {
    if (c.anchor?.line !== undefined) {
      continue;
    }
    const fromActivity = known.get(c.id);
    const fromLine = byLine.get(c.id);
    if (fromLine) {
      // Current position in the effective diff; the activity only contributes the side of CONTEXT comments.
      const fileType: FileType = fromLine.type === 'REMOVED' ? 'FROM' : fromLine.type === 'ADDED' ? 'TO' : (fromActivity?.fileType ?? 'TO');
      c.anchor = {
        path,
        srcPath,
        lineType: fromLine.type,
        fileType,
        line: fileType === 'FROM' ? fromLine.source : fromLine.destination,
        diffType: 'EFFECTIVE',
        multilineMarker: fromActivity?.multilineMarker,
      };
    } else if (fromActivity?.line !== undefined) {
      c.anchor = { ...fromActivity, path: fromActivity.path || path };
    } else {
      c.anchor = { path, srcPath, diffType: 'EFFECTIVE', orphaned: true };
    }
  }
}
