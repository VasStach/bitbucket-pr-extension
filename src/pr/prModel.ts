import * as vscode from 'vscode';
import { BitbucketClient, BitbucketError, type RepoCoords } from '../bitbucket/client';
import type { Change, Comment, CommentAnchor, CommentSeverity, CreateCommentRequest, FileDiff, PullRequest } from '../bitbucket/types';
import { attachAnchors } from '../core/attachAnchors';
import { countTasks, isOpenTask } from '../core/commentState';
import { log } from '../util/logger';

export interface FileDiffData {
  /** Destination path (or source path for deleted files). */
  path: string;
  srcPath?: string;
  fromHash: string;
  toHash: string;
  diff: FileDiff;
  lineComments: Comment[];
  fileComments: Comment[];
}

export interface ChangedFile {
  path: string;
  srcPath?: string;
  change: Change;
  /** Number of root inline comments known for the file (from activities until the diff is loaded). */
  commentCount: number;
  /** Open (unresolved) tasks in the file's threads, including task replies. */
  openTaskCount: number;
}

/** Everything known about the PR currently associated with the checked-out branch. */
export class PrModel implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  private _pr: PullRequest;
  private _changes: ChangedFile[] = [];
  private _generalComments: Comment[] = [];
  private readonly fileDiffs = new Map<string, FileDiffData>();
  private readonly pendingDiffs = new Map<string, Promise<FileDiffData | undefined>>();
  private readonly commentCountsFromActivities = new Map<string, { total: number; openTasks: number }>();
  /** Inline comment id -> anchor as reported by the activity stream (the diff endpoint omits anchors). */
  private readonly anchorsFromActivities = new Map<number, CommentAnchor>();
  private _currentUserSlug: string | undefined;
  private _loading = false;
  private disposed = false;

  constructor(
    readonly client: BitbucketClient,
    readonly repo: RepoCoords,
    pr: PullRequest,
  ) {
    this._pr = pr;
  }

  // ---------------------------------------------------------------- getters

  get pr(): PullRequest {
    return this._pr;
  }

  get id(): number {
    return this._pr.id;
  }

  get changes(): ChangedFile[] {
    return this._changes;
  }

  get generalComments(): Comment[] {
    return this._generalComments;
  }

  get loading(): boolean {
    return this._loading;
  }

  get currentUserSlug(): string | undefined {
    return this._currentUserSlug;
  }

  get sourceCommit(): string {
    return this._pr.fromRef.latestCommit;
  }

  get targetCommit(): string {
    return this._pr.toRef.latestCommit;
  }

  get webUrl(): string {
    return this._pr.links?.self?.[0]?.href ?? this.client.pullRequestUrl(this.repo, this._pr.id);
  }

  /** Cached file diff (undefined when not loaded yet). */
  getLoadedDiff(path: string): FileDiffData | undefined {
    return this.fileDiffs.get(path);
  }

  changeForPath(path: string): ChangedFile | undefined {
    return this._changes.find((c) => c.path === path || c.srcPath === path);
  }

  /** All loaded inline comments, flattened per file. */
  get loadedFileDiffs(): FileDiffData[] {
    return [...this.fileDiffs.values()];
  }

  /** Open tasks across general and inline comments (root comments and replies). */
  get openTaskCount(): number {
    let n = countTasks(this._generalComments).open;
    const loadedPaths = new Set<string>();
    for (const fd of this.fileDiffs.values()) {
      loadedPaths.add(fd.path);
      n += countTasks(fd.lineComments).open;
    }
    for (const [path, counts] of this.commentCountsFromActivities) {
      if (!loadedPaths.has(path)) {
        n += counts.openTasks;
      }
    }
    return n;
  }

  /** Server-side task counters from the PR (authoritative, refreshed on reload). */
  get serverTaskCounts(): { open: number; resolved: number } | undefined {
    const p = this._pr.properties;
    if (p?.openTaskCount === undefined) {
      return undefined;
    }
    return { open: p.openTaskCount, resolved: p.resolvedTaskCount ?? 0 };
  }

  // ---------------------------------------------------------------- loading

  /** Loads PR metadata, changed files, general comments and the diffs of files that have comments. */
  async reload(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this._loading = true;
    this._onDidChange.fire();
    try {
      const [pr, changes, general, activities, slug] = await Promise.all([
        this.client.getPullRequest(this.repo, this._pr.id),
        this.client.getChanges(this.repo, this._pr.id),
        this.client.getGeneralComments(this.repo, this._pr.id).catch((e) => {
          log.warn(`Could not load general comments: ${(e as Error).message}`);
          return [] as Comment[];
        }),
        this.client.getActivities(this.repo, this._pr.id).catch((e) => {
          log.warn(`Could not load activities: ${(e as Error).message}`);
          return [];
        }),
        this._currentUserSlug ? Promise.resolve(this._currentUserSlug) : this.client.whoAmI(),
      ]);
      if (this.disposed) {
        return;
      }
      const sourceChanged = pr.fromRef.latestCommit !== this._pr.fromRef.latestCommit || pr.toRef.latestCommit !== this._pr.toRef.latestCommit;
      this._pr = pr;
      this._currentUserSlug = slug;
      this._generalComments = general.sort((a, b) => a.createdDate - b.createdDate);

      // Inline comment counts per path from the activity stream.
      this.commentCountsFromActivities.clear();
      this.anchorsFromActivities.clear();
      const pathsWithComments = new Set<string>();
      for (const a of activities) {
        if (a.action !== 'COMMENTED' || !a.commentAnchor?.path) {
          continue;
        }
        if (a.comment) {
          this.anchorsFromActivities.set(a.comment.id, a.commentAnchor);
        }
        const path = a.commentAnchor.path;
        pathsWithComments.add(path);
        if (a.commentAnchor.srcPath) {
          pathsWithComments.add(a.commentAnchor.srcPath);
        }
        if (a.commentAction === 'ADDED' && a.comment) {
          const entry = this.commentCountsFromActivities.get(path) ?? { total: 0, openTasks: 0 };
          if (!a.comment.parent) {
            entry.total++;
          }
          if (isOpenTask(a.comment)) {
            entry.openTasks++;
          }
          this.commentCountsFromActivities.set(path, entry);
        }
      }

      this._changes = changes
        .filter((c) => c.nodeType !== 'DIRECTORY')
        .map((c) => {
          const path = c.path.toString;
          const counts = this.commentCountsFromActivities.get(path) ?? (c.srcPath ? this.commentCountsFromActivities.get(c.srcPath.toString) : undefined);
          return {
            path,
            srcPath: c.srcPath?.toString,
            change: c,
            commentCount: counts?.total ?? 0,
            openTaskCount: counts?.openTasks ?? 0,
          };
        })
        .sort((a, b) => a.path.localeCompare(b.path));

      // Invalidate diffs when commits moved, otherwise refresh the loaded ones.
      const toReload = sourceChanged ? [] : [...this.fileDiffs.keys()];
      this.fileDiffs.clear();
      const wanted = new Set<string>([...toReload]);
      for (const cf of this._changes) {
        if (pathsWithComments.has(cf.path) || (cf.srcPath && pathsWithComments.has(cf.srcPath))) {
          wanted.add(cf.path);
        }
      }
      await this.loadDiffs([...wanted]);
      this.refreshCountsFromDiffs();
    } finally {
      this._loading = false;
      if (!this.disposed) {
        this._onDidChange.fire();
      }
    }
  }

  private async loadDiffs(paths: string[], concurrency = 4): Promise<void> {
    const queue = [...paths];
    const worker = async () => {
      while (queue.length) {
        const p = queue.shift()!;
        try {
          await this.loadFileDiff(p);
        } catch (e) {
          log.warn(`Could not load diff for ${p}: ${(e as Error).message}`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  }

  /** Loads (or returns the cached) diff for a changed file. `path` may be the destination or source path. */
  async loadFileDiff(path: string, force = false): Promise<FileDiffData | undefined> {
    const cf = this.changeForPath(path);
    const key = cf?.path ?? path;
    if (!force) {
      const cached = this.fileDiffs.get(key);
      if (cached) {
        return cached;
      }
      const pending = this.pendingDiffs.get(key);
      if (pending) {
        return pending;
      }
    }
    const contextLines = vscode.workspace.getConfiguration('bitbucketPr').get<number>('contextLines', 10);
    const promise = (async () => {
      const resp = await this.client.getFileDiff(this.repo, this._pr.id, key, {
        srcPath: cf?.srcPath,
        contextLines,
        withComments: true,
      });
      const diff = resp.diffs?.[0];
      if (!diff) {
        return undefined;
      }
      const lineComments = (diff.lineComments ?? []).slice().sort((a, b) => a.createdDate - b.createdDate);
      attachAnchors(lineComments, diff, key, cf?.srcPath, this.anchorsFromActivities);
      const data: FileDiffData = {
        path: key,
        srcPath: cf?.srcPath ?? diff.source?.toString,
        fromHash: resp.fromHash,
        toHash: resp.toHash,
        diff,
        lineComments,
        fileComments: diff.fileComments ?? [],
      };
      if (!this.disposed) {
        this.fileDiffs.set(key, data);
      }
      return data;
    })();
    this.pendingDiffs.set(key, promise);
    try {
      return await promise;
    } finally {
      this.pendingDiffs.delete(key);
    }
  }

  private refreshCountsFromDiffs(): void {
    for (const cf of this._changes) {
      const fd = this.fileDiffs.get(cf.path);
      if (fd) {
        cf.commentCount = fd.lineComments.length;
        cf.openTaskCount = countTasks(fd.lineComments).open;
      }
    }
  }

  // ---------------------------------------------------------------- mutations

  async createInlineComment(anchor: NonNullable<CreateCommentRequest['anchor']>, text: string, severity: CommentSeverity = 'NORMAL'): Promise<Comment> {
    const created = await this.client.createComment(this.repo, this._pr.id, { text, severity, anchor });
    await this.afterInlineMutation(anchor.path);
    return created;
  }

  async createGeneralComment(text: string, severity: CommentSeverity = 'NORMAL'): Promise<Comment> {
    const created = await this.client.createComment(this.repo, this._pr.id, { text, severity });
    await this.afterGeneralMutation();
    return created;
  }

  async reply(parent: Comment, text: string, path?: string, severity: CommentSeverity = 'NORMAL'): Promise<Comment> {
    const created = await this.client.createComment(this.repo, this._pr.id, { text, severity, parent: { id: parent.id } });
    await this.afterMutation(path);
    return created;
  }

  async editComment(comment: Comment, text: string, path?: string): Promise<Comment> {
    const updated = await this.client.updateComment(this.repo, this._pr.id, comment.id, { version: comment.version, text });
    await this.afterMutation(path);
    return updated;
  }

  async deleteComment(comment: Comment, path?: string): Promise<void> {
    await this.client.deleteComment(this.repo, this._pr.id, comment.id, comment.version);
    await this.afterMutation(path);
  }

  /** Completes or reopens a task (BLOCKER comment). Only tasks are resolved from the IDE. */
  async setTaskState(task: Comment, state: 'OPEN' | 'RESOLVED', path?: string): Promise<Comment> {
    const updated = await this.client.updateComment(this.repo, this._pr.id, task.id, { version: task.version, state });
    await this.afterMutation(path);
    return updated;
  }

  private async afterMutation(path?: string): Promise<void> {
    if (path) {
      await this.afterInlineMutation(path);
    } else {
      await this.afterGeneralMutation();
    }
  }

  private async afterInlineMutation(path: string): Promise<void> {
    try {
      await this.loadFileDiff(path, true);
      this.refreshCountsFromDiffs();
    } catch (e) {
      log.warn(`Refresh after comment change failed for ${path}: ${(e as Error).message}`);
    }
    this._onDidChange.fire();
  }

  private async afterGeneralMutation(): Promise<void> {
    try {
      this._generalComments = (await this.client.getGeneralComments(this.repo, this._pr.id)).sort((a, b) => a.createdDate - b.createdDate);
    } catch (e) {
      log.warn(`Refresh of general comments failed: ${(e as Error).message}`);
    }
    this._onDidChange.fire();
  }

  // ---------------------------------------------------------------- helpers

  /** Finds a comment (root or reply) by id across general and loaded inline comments. */
  findComment(id: number): { comment: Comment; root: Comment; path?: string } | undefined {
    const search = (roots: Comment[], path?: string) => {
      for (const root of roots) {
        const found = findInTree(root, id);
        if (found) {
          return { comment: found, root, path };
        }
      }
      return undefined;
    };
    const general = search(this._generalComments);
    if (general) {
      return general;
    }
    for (const fd of this.fileDiffs.values()) {
      const r = search(fd.lineComments, fd.path);
      if (r) {
        return r;
      }
    }
    return undefined;
  }

  static isVersionConflict(e: unknown): boolean {
    return e instanceof BitbucketError && e.kind === 'conflict';
  }

  dispose(): void {
    this.disposed = true;
    this._onDidChange.dispose();
  }
}

export { isResolved, isUnresolved, isTask, isOpenTask } from '../core/commentState';

function findInTree(root: Comment, id: number): Comment | undefined {
  if (root.id === id) {
    return root;
  }
  for (const child of root.comments ?? []) {
    const f = findInTree(child, id);
    if (f) {
      return f;
    }
  }
  return undefined;
}

/** Flattens a comment thread into display order (root first, replies depth-first). */
export function flattenThread(root: Comment): Comment[] {
  const out: Comment[] = [];
  const walk = (c: Comment) => {
    out.push(c);
    for (const child of (c.comments ?? []).slice().sort((a, b) => a.createdDate - b.createdDate)) {
      walk(child);
    }
  };
  walk(root);
  return out;
}

export function anchorKey(a: CommentAnchor | undefined): string {
  if (!a) {
    return 'general';
  }
  return `${a.path}|${a.fileType ?? ''}|${a.lineType ?? ''}|${a.line ?? ''}`;
}
