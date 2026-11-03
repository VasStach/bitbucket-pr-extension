/**
 * Subset of Bitbucket Data Center REST API 1.0 types used by the extension.
 * Field names mirror the JSON returned by the server.
 */

export interface Page<T> {
  size: number;
  limit: number;
  isLastPage: boolean;
  start: number;
  nextPageStart?: number;
  values: T[];
}

export interface BbUser {
  name: string;
  displayName: string;
  emailAddress?: string;
  slug: string;
  id: number;
  active?: boolean;
  type?: string;
  avatarUrl?: string;
  links?: BbLinks;
}

export interface BbLinks {
  self?: { href: string }[];
}

export interface BbProject {
  key: string;
  id?: number;
  name?: string;
  public?: boolean;
  type?: string;
  links?: BbLinks;
}

export interface BbRepository {
  slug: string;
  id?: number;
  name?: string;
  project: BbProject;
  links?: BbLinks & { clone?: { href: string; name: string }[] };
}

export interface BbRef {
  /** e.g. refs/heads/feature/x */
  id: string;
  displayId: string;
  latestCommit: string;
  type?: string;
  repository: BbRepository;
}

export type PrState = 'OPEN' | 'MERGED' | 'DECLINED';

export interface BbParticipant {
  user: BbUser;
  role: 'AUTHOR' | 'REVIEWER' | 'PARTICIPANT';
  approved: boolean;
  status: 'UNAPPROVED' | 'NEEDS_WORK' | 'APPROVED';
  lastReviewedCommit?: string;
}

export interface PullRequest {
  id: number;
  version: number;
  title: string;
  description?: string;
  state: PrState;
  open: boolean;
  closed: boolean;
  draft?: boolean;
  createdDate: number;
  updatedDate: number;
  fromRef: BbRef;
  toRef: BbRef;
  locked?: boolean;
  author: BbParticipant;
  reviewers: BbParticipant[];
  participants: BbParticipant[];
  properties?: {
    commentCount?: number;
    openTaskCount?: number;
    resolvedTaskCount?: number;
    mergeResult?: { outcome: string; current: boolean };
  };
  links?: BbLinks;
}

export type ChangeType = 'ADD' | 'MODIFY' | 'DELETE' | 'MOVE' | 'COPY' | 'RENAME' | 'UNKNOWN';

export interface BbPath {
  components: string[];
  parent?: string;
  name: string;
  extension?: string;
  toString: string;
}

export interface Change {
  contentId?: string;
  fromContentId?: string;
  path: BbPath;
  srcPath?: BbPath;
  executable?: boolean;
  percentUnchanged?: number;
  type: ChangeType;
  nodeType: 'FILE' | 'DIRECTORY' | 'SUBMODULE';
  srcExecutable?: boolean;
  links?: BbLinks;
  properties?: Record<string, unknown>;
}

export type LineType = 'ADDED' | 'REMOVED' | 'CONTEXT';
export type FileType = 'FROM' | 'TO';
export type DiffType = 'EFFECTIVE' | 'COMMIT' | 'RANGE';

export interface CommentAnchor {
  fromHash?: string;
  toHash?: string;
  /** 1-based line number in the file given by `fileType`. */
  line?: number;
  lineType?: LineType;
  fileType?: FileType;
  path: string;
  srcPath?: string;
  diffType?: DiffType;
  orphaned?: boolean;
  /** Present for multi-line comments (DC 8.x). */
  multilineMarker?: { startLine: number; startLineType: LineType };
}

export type CommentSeverity = 'NORMAL' | 'BLOCKER';
export type CommentState = 'OPEN' | 'RESOLVED' | 'PENDING';

export interface PermittedOperations {
  editable: boolean;
  deletable: boolean;
  transitionable?: boolean;
}

export interface Comment {
  id: number;
  version: number;
  text: string;
  html?: string;
  author: BbUser;
  createdDate: number;
  updatedDate: number;
  /** Replies (nested). */
  comments: Comment[];
  severity?: CommentSeverity;
  state?: CommentState;
  threadResolved?: boolean;
  threadResolvedDate?: number;
  threadResolver?: BbUser;
  resolvedDate?: number;
  resolver?: BbUser;
  anchor?: CommentAnchor;
  permittedOperations?: PermittedOperations;
  properties?: Record<string, unknown>;
  parent?: { id: number };
  tasks?: unknown[];
}

export interface DiffLine {
  /** 1-based line number in the source (FROM) file; for ADDED lines this is the position after which it was inserted. */
  source: number;
  /** 1-based line number in the destination (TO) file. */
  destination: number;
  line: string;
  truncated?: boolean;
  commentIds?: number[];
  conflictMarker?: string;
}

export interface DiffSegment {
  type: LineType;
  lines: DiffLine[];
  truncated?: boolean;
}

export interface DiffHunk {
  context?: string;
  sourceLine: number;
  sourceSpan: number;
  destinationLine: number;
  destinationSpan: number;
  segments: DiffSegment[];
  truncated?: boolean;
}

export interface FileDiff {
  source?: BbPath | null;
  destination?: BbPath | null;
  hunks: DiffHunk[];
  truncated?: boolean;
  binary?: boolean;
  lineComments?: Comment[];
  fileComments?: Comment[];
  properties?: Record<string, unknown>;
}

export interface DiffResponse {
  fromHash: string;
  toHash: string;
  contextLines: number;
  whitespace: string;
  diffs: FileDiff[];
  truncated?: boolean;
}

export interface Activity {
  id: number;
  createdDate: number;
  user: BbUser;
  action: string;
  commentAction?: 'ADDED' | 'UPDATED' | 'DELETED' | 'REPLIED';
  comment?: Comment;
  commentAnchor?: CommentAnchor;
}

export interface CreateCommentRequest {
  text: string;
  severity?: CommentSeverity;
  parent?: { id: number };
  anchor?: {
    path: string;
    srcPath?: string;
    line: number;
    lineType: LineType;
    fileType: FileType;
    diffType: DiffType;
    fromHash?: string;
    toHash?: string;
  };
}

export interface UpdateCommentRequest {
  version: number;
  text?: string;
  /** Task state (BLOCKER comments). */
  state?: CommentState;
  severity?: CommentSeverity;
  /** Thread resolution (Bitbucket DC 8.9+). */
  threadResolved?: boolean;
}
