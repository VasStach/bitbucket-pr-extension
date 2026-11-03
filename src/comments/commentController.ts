import * as vscode from 'vscode';
import type { AccessState } from '../auth/accessState';
import { BitbucketError } from '../bitbucket/client';
import type { Comment, FileDiff } from '../bitbucket/types';
import { anchorStartLine, displayLine, positionToAnchor, type Side } from '../core/anchorMapper';
import { openPrDiff } from '../diff/openDiff';
import { parseOverviewUri, parsePrFileUri } from '../diff/prUris';
import type { RepoContext, RepoInfo } from '../git/repoContext';
import type { CommentSeverity } from '../bitbucket/types';
import { isResolved, isResolvedTask, isTask } from '../core/commentState';
import { flattenThread, type PrModel } from '../pr/prModel';
import type { PrResolver } from '../pr/prResolver';
import { log } from '../util/logger';

const CONTROLLER_ID = 'bitbucketPr';

/** A VS Code comment backed by a Bitbucket comment. */
export class BbComment implements vscode.Comment {
  body: string | vscode.MarkdownString;
  mode: vscode.CommentMode = vscode.CommentMode.Preview;
  author: vscode.CommentAuthorInformation;
  contextValue?: string;
  label?: string;
  timestamp?: Date;
  /** Text before an edit started, used by Cancel. */
  savedBody: string;

  constructor(
    readonly data: Comment,
    readonly path: string | undefined,
    readonly isRoot: boolean,
    readonly thread: vscode.CommentThread,
    canWrite: boolean,
  ) {
    this.body = renderBody(data);
    this.savedBody = data.text;
    this.author = { name: data.author?.displayName ?? data.author?.name ?? 'unknown' };
    this.timestamp = new Date(data.createdDate);
    const labels: string[] = [];
    if (isTask(data)) {
      labels.push(isResolvedTask(data) ? 'TASK · resolved' : 'TASK · open');
    }
    if (data.updatedDate && data.updatedDate !== data.createdDate) {
      labels.push('edited');
    }
    this.label = labels.join(' · ') || undefined;
    const ops: string[] = [];
    if (canWrite && isTask(data) && data.permittedOperations?.transitionable !== false) {
      ops.push(isResolvedTask(data) ? 'canReopenTask' : 'canResolveTask');
    }
    if (canWrite && data.permittedOperations?.editable !== false) {
      ops.push('canEdit');
    }
    if (canWrite && data.permittedOperations?.deletable !== false) {
      ops.push('canDelete');
    }
    this.contextValue = ops.join(' ');
  }
}

/** Comment text as Markdown; tasks get a visible checkbox marker on the first line. */
function renderBody(data: Comment): vscode.MarkdownString {
  if (!isTask(data)) {
    return toMarkdown(data.text);
  }
  const marker = isResolvedTask(data) ? '☑ **Task — resolved**' : '☐ **Task — open**';
  return toMarkdown(`${marker}\n\n${data.text ?? ''}`);
}

interface ThreadMeta {
  model: PrModel;
  root: Comment;
  /** Repository path for inline threads; undefined for general comments. */
  path?: string;
  side?: Side;
}

type DocKind =
  | { type: 'prFile'; model: PrModel; path: string; side: Side }
  | { type: 'local'; model: PrModel; path: string; repo: RepoInfo }
  | { type: 'overview'; model: PrModel };

interface DesiredThread {
  root: Comment;
  range: vscode.Range;
  path?: string;
  side?: Side;
  label?: string;
}

function toMarkdown(text: string): vscode.MarkdownString {
  const md = new vscode.MarkdownString(text ?? '');
  md.isTrusted = false;
  md.supportHtml = false;
  return md;
}

/**
 * Bridges Bitbucket comment threads and the VS Code Comments API for:
 *  - PR diff documents (`bbpr:` FROM / TO sides),
 *  - local files of the checked-out branch (mapped to the TO side),
 *  - the PR overview document (general comments).
 */
export class PrCommentController implements vscode.Disposable {
  private readonly controller: vscode.CommentController;
  /** document uri string -> root comment id -> thread */
  private readonly threadsByDoc = new Map<string, Map<number, vscode.CommentThread>>();
  private readonly meta = new WeakMap<vscode.CommentThread, ThreadMeta>();
  /** Temporary threads created by the user that have not been submitted yet. */
  private readonly draftThreads = new Set<vscode.CommentThread>();
  private readonly attemptedDiffLoads = new Set<string>();
  private readonly disposables: vscode.Disposable[] = [];
  private model: PrModel | undefined;
  private modelListener: vscode.Disposable | undefined;
  private syncScheduled = false;

  constructor(
    resolver: PrResolver,
    private readonly repoContext: RepoContext,
    private readonly access: AccessState,
  ) {
    this.controller = vscode.comments.createCommentController(CONTROLLER_ID, 'Bitbucket Pull Request');
    this.controller.options = { placeHolder: 'Comment on the pull request…', prompt: 'Comments are posted to Bitbucket immediately.' };
    this.controller.commentingRangeProvider = {
      provideCommentingRanges: (document) => this.provideCommentingRanges(document),
    };
    this.disposables.push(
      this.controller,
      resolver.onDidChangePr((m) => this.setModel(m)),
      access.onDidChange(() => this.scheduleSync()),
      repoContext.onDidChangeWorkingTree(() => this.scheduleSync()),
      vscode.workspace.onDidOpenTextDocument(() => this.scheduleSync()),
      vscode.workspace.onDidCloseTextDocument((doc) => this.disposeThreadsFor(doc.uri)),
      vscode.window.onDidChangeVisibleTextEditors(() => this.scheduleSync()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('bitbucketPr.showOnLocalFiles')) {
          this.scheduleSync(true);
        }
      }),
    );
    this.setModel(resolver.current);
  }

  // ---------------------------------------------------------------- model wiring

  private setModel(model: PrModel | undefined): void {
    this.modelListener?.dispose();
    this.modelListener = undefined;
    this.model = model;
    this.attemptedDiffLoads.clear();
    if (model) {
      this.modelListener = model.onDidChange(() => this.scheduleSync());
    }
    this.scheduleSync(true);
  }

  private scheduleSync(full = false): void {
    if (full) {
      // Drop threads whose document kind might have changed.
      for (const key of [...this.threadsByDoc.keys()]) {
        this.disposeThreadsFor(vscode.Uri.parse(key));
      }
    }
    if (this.syncScheduled) {
      return;
    }
    this.syncScheduled = true;
    setTimeout(() => {
      this.syncScheduled = false;
      void this.syncAll();
    }, 50);
  }

  private get canWrite(): boolean {
    return !this.access.readOnly;
  }

  // ---------------------------------------------------------------- classification

  private classify(uri: vscode.Uri): DocKind | undefined {
    const model = this.model;
    if (!model) {
      return undefined;
    }
    const prFile = parsePrFileUri(uri);
    if (prFile) {
      if (prFile.prId !== model.id) {
        return undefined;
      }
      return { type: 'prFile', model, path: prFile.path, side: prFile.side };
    }
    const overview = parseOverviewUri(uri);
    if (overview) {
      return overview.prId === model.id ? { type: 'overview', model } : undefined;
    }
    if (uri.scheme === 'file') {
      if (!vscode.workspace.getConfiguration('bitbucketPr').get<boolean>('showOnLocalFiles', true)) {
        return undefined;
      }
      const repo = this.repoContext.repoForUri(uri);
      if (!repo || repo.repository !== this.repoContext.currentRepo?.repository) {
        return undefined;
      }
      const rel = this.repoContext.relativePath(repo, uri);
      if (!rel || !model.changeForPath(rel)) {
        return undefined;
      }
      return { type: 'local', model, path: rel, repo };
    }
    return undefined;
  }

  /**
   * Returns undefined when the local checkout matches the PR source commit and the file is unmodified,
   * otherwise a short human-readable reason.
   */
  private localStaleness(kind: Extract<DocKind, { type: 'local' }>, uri: vscode.Uri): string | undefined {
    const head = this.repoContext.branchState.headCommit;
    const source = kind.model.sourceCommit;
    if (!head) {
      return 'local HEAD unknown';
    }
    if (head !== source) {
      return `local HEAD ${head.substring(0, 7)} differs from PR source ${source.substring(0, 7)}`;
    }
    if (this.repoContext.isFileDirty(kind.repo, uri)) {
      return 'file has uncommitted changes';
    }
    return undefined;
  }

  private isLocalFresh(kind: Extract<DocKind, { type: 'local' }>, uri: vscode.Uri): boolean {
    return this.localStaleness(kind, uri) === undefined;
  }

  // ---------------------------------------------------------------- commenting ranges

  private async provideCommentingRanges(document: vscode.TextDocument): Promise<vscode.Range[]> {
    if (!this.canWrite) {
      return [];
    }
    const kind = this.classify(document.uri);
    if (!kind) {
      return [];
    }
    const lastLine = Math.max(0, document.lineCount - 1);
    const whole = [new vscode.Range(0, 0, lastLine, 0)];
    switch (kind.type) {
      case 'overview':
        return whole;
      case 'prFile': {
        const fd = await kind.model.loadFileDiff(kind.path).catch(() => undefined);
        if (fd?.diff.binary) {
          return [];
        }
        if (kind.side === 'FROM' && fd?.diff.source == null) {
          return [];
        }
        if (kind.side === 'TO' && fd?.diff.destination == null) {
          return [];
        }
        return whole;
      }
      case 'local':
        return this.isLocalFresh(kind, document.uri) ? whole : [];
    }
  }

  // ---------------------------------------------------------------- syncing

  private async syncAll(): Promise<void> {
    const docs = new Map<string, vscode.TextDocument>();
    for (const editor of vscode.window.visibleTextEditors) {
      docs.set(editor.document.uri.toString(), editor.document);
    }
    for (const doc of vscode.workspace.textDocuments) {
      docs.set(doc.uri.toString(), doc);
    }
    // Dispose threads of documents no longer open.
    for (const key of [...this.threadsByDoc.keys()]) {
      if (!docs.has(key)) {
        this.disposeThreadsFor(vscode.Uri.parse(key));
      }
    }
    for (const doc of docs.values()) {
      try {
        await this.syncDocument(doc);
      } catch (e) {
        log.error(`Comment sync failed for ${doc.uri.toString()}`, e);
      }
    }
  }

  private async syncDocument(doc: vscode.TextDocument): Promise<void> {
    const kind = this.classify(doc.uri);
    if (!kind) {
      this.disposeThreadsFor(doc.uri);
      return;
    }
    const desired = await this.desiredThreads(kind, doc);
    const key = doc.uri.toString();
    let existing = this.threadsByDoc.get(key);
    if (!existing) {
      existing = new Map();
      this.threadsByDoc.set(key, existing);
    }
    const seen = new Set<number>();
    for (const d of desired) {
      seen.add(d.root.id);
      const thread = existing.get(d.root.id);
      if (thread) {
        this.updateThread(thread, kind.model, d);
      } else {
        const created = this.controller.createCommentThread(doc.uri, d.range, []);
        existing.set(d.root.id, created);
        this.updateThread(created, kind.model, d, true);
      }
    }
    for (const [id, thread] of [...existing.entries()]) {
      if (!seen.has(id)) {
        thread.dispose();
        existing.delete(id);
      }
    }
  }

  private async desiredThreads(kind: DocKind, doc: vscode.TextDocument): Promise<DesiredThread[]> {
    const out: DesiredThread[] = [];
    const lastLine = Math.max(0, doc.lineCount - 1);
    const clamp = (line1: number) => Math.min(lastLine, Math.max(0, line1 - 1));

    if (kind.type === 'overview') {
      for (const root of kind.model.generalComments) {
        out.push({ root, range: new vscode.Range(lastLine, 0, lastLine, 0) });
      }
      return out;
    }

    const fd = kind.model.getLoadedDiff(kind.path);
    if (!fd) {
      // Load lazily (once per path and model), then re-sync.
      const loadKey = `${kind.model.id}|${kind.path}`;
      if (!this.attemptedDiffLoads.has(loadKey)) {
        this.attemptedDiffLoads.add(loadKey);
        void kind.model
          .loadFileDiff(kind.path)
          .then((loaded) => {
            if (loaded) {
              this.scheduleSync();
            }
          })
          .catch((e) => log.warn(`Diff load failed for ${kind.path}: ${(e as Error).message}`));
      }
      return out;
    }
    const diff: FileDiff = fd.diff;
    const side: Side = kind.type === 'prFile' ? kind.side : 'TO';
    const staleness = kind.type === 'local' ? this.localStaleness(kind, doc.uri) : undefined;

    for (const root of fd.lineComments) {
      const anchor = root.anchor;
      if (!anchor || anchor.line === undefined) {
        continue;
      }
      if (kind.type === 'prFile') {
        // Show each thread on the side it was made on (like Bitbucket's side-by-side view).
        const anchorSide: Side = anchor.lineType === 'ADDED' ? 'TO' : anchor.lineType === 'REMOVED' ? 'FROM' : (anchor.fileType ?? 'TO');
        if (anchorSide !== side) {
          continue;
        }
      }
      const pos = displayLine(diff, anchor, side);
      if (!pos) {
        continue;
      }
      const labels: string[] = [];
      if (anchor.orphaned) {
        labels.push('orphaned');
      }
      if (pos.approximate) {
        labels.push('on a removed line (approximate position)');
      }
      if (staleness) {
        labels.push(`outdated – ${staleness}`);
      }
      const startLine = anchorStartLine(anchor) ?? anchor.line;
      const startOffset = anchor.line - startLine;
      const endLine = clamp(pos.line);
      const beginLine = Math.max(0, endLine - Math.max(0, startOffset));
      out.push({
        root,
        range: new vscode.Range(beginLine, 0, endLine, 0),
        path: fd.path,
        side,
        label: labels.join(' · ') || undefined,
      });
    }
    return out;
  }

  private updateThread(thread: vscode.CommentThread, model: PrModel, d: DesiredThread, isNew = false): void {
    const resolved = isResolved(d.root);
    this.meta.set(thread, { model, root: d.root, path: d.path, side: d.side });
    const previous = new Map<number, BbComment>();
    for (const c of thread.comments) {
      if (c instanceof BbComment) {
        previous.set(c.data.id, c);
      }
    }
    const comments = flattenThread(d.root).map((c) => {
      const bb = new BbComment(c, d.path, c.id === d.root.id, thread, this.canWrite);
      const prev = previous.get(c.id);
      if (prev && prev.mode === vscode.CommentMode.Editing) {
        bb.mode = vscode.CommentMode.Editing;
        bb.body = prev.body;
      }
      return bb;
    });
    if (!thread.range || !thread.range.isEqual(d.range)) {
      thread.range = d.range;
    }
    thread.comments = comments;
    thread.canReply = this.canWrite;
    // Thread state is only meaningful for tasks; plain comment threads are collapsed when resolved on the server.
    thread.state = isTask(d.root) ? (resolved ? vscode.CommentThreadState.Resolved : vscode.CommentThreadState.Unresolved) : undefined;
    thread.contextValue = isTask(d.root) ? 'task' : 'comment';
    const kind = isTask(d.root) ? (resolved ? 'Task resolved' : 'Task') : resolved ? 'Resolved' : undefined;
    const label = [kind, d.label].filter(Boolean).join(' · ');
    thread.label = label || undefined;
    if (isNew) {
      thread.collapsibleState = resolved ? vscode.CommentThreadCollapsibleState.Collapsed : vscode.CommentThreadCollapsibleState.Expanded;
    }
  }

  private disposeThreadsFor(uri: vscode.Uri): void {
    const key = uri.toString();
    const threads = this.threadsByDoc.get(key);
    if (threads) {
      threads.forEach((t) => t.dispose());
      this.threadsByDoc.delete(key);
    }
  }

  // ---------------------------------------------------------------- commands

  /** `bitbucketPr.createThread` / `bitbucketPr.createTask` – first comment in a new (draft) thread. */
  async createThread(reply: vscode.CommentReply, severity: CommentSeverity = 'NORMAL'): Promise<void> {
    const thread = reply.thread;
    const text = reply.text.trim();
    if (!text) {
      return;
    }
    const kind = this.classify(thread.uri);
    if (!kind) {
      void vscode.window.showWarningMessage('Bitbucket PR: this document is not part of the current pull request.');
      return;
    }
    this.draftThreads.add(thread);
    await this.runWrite(kind.model, async () => {
      if (kind.type === 'overview') {
        await kind.model.createGeneralComment(text, severity);
      } else {
        const fd = await kind.model.loadFileDiff(kind.path);
        const side: Side = kind.type === 'prFile' ? kind.side : 'TO';
        const line = (thread.range?.start.line ?? 0) + 1;
        const spec = positionToAnchor(fd?.diff, side, line);
        if (!spec) {
          throw new Error('This line cannot be commented on (it does not exist on this side of the diff).');
        }
        const cf = kind.model.changeForPath(kind.path);
        await kind.model.createInlineComment(
          {
            path: cf?.path ?? kind.path,
            srcPath: cf?.srcPath,
            line: spec.line,
            lineType: spec.lineType,
            fileType: spec.fileType,
            diffType: 'EFFECTIVE',
            fromHash: fd?.fromHash,
            toHash: fd?.toHash,
          },
          text,
          severity,
        );
      }
      this.draftThreads.delete(thread);
      thread.dispose();
    });
  }

  /** `bitbucketPr.replyThread` / `bitbucketPr.replyTask` */
  async replyThread(reply: vscode.CommentReply, severity: CommentSeverity = 'NORMAL'): Promise<void> {
    const meta = this.meta.get(reply.thread);
    const text = reply.text.trim();
    if (!meta || !text) {
      return;
    }
    // Replies are attached to the root; Bitbucket displays the thread flat under it.
    await this.runWrite(meta.model, () => meta.model.reply(meta.root, text, meta.path, severity));
  }

  /** `bitbucketPr.editComment` */
  editComment(comment: BbComment): void {
    if (!(comment instanceof BbComment)) {
      return;
    }
    comment.savedBody = comment.data.text;
    comment.mode = vscode.CommentMode.Editing;
    comment.body = comment.data.text;
    comment.thread.comments = [...comment.thread.comments];
  }

  /** `bitbucketPr.saveComment` */
  async saveComment(comment: BbComment): Promise<void> {
    if (!(comment instanceof BbComment)) {
      return;
    }
    const meta = this.meta.get(comment.thread);
    if (!meta) {
      return;
    }
    const text = (typeof comment.body === 'string' ? comment.body : comment.body.value).trim();
    if (!text || text === comment.data.text) {
      this.cancelEditComment(comment);
      return;
    }
    await this.runWrite(meta.model, async () => {
      await meta.model.editComment(comment.data, text, meta.path);
      comment.mode = vscode.CommentMode.Preview;
    });
  }

  /** `bitbucketPr.cancelEditComment` */
  cancelEditComment(comment: BbComment): void {
    if (!(comment instanceof BbComment)) {
      return;
    }
    comment.body = toMarkdown(comment.savedBody);
    comment.mode = vscode.CommentMode.Preview;
    comment.thread.comments = [...comment.thread.comments];
  }

  /** `bitbucketPr.deleteComment` */
  async deleteComment(comment: BbComment): Promise<void> {
    if (!(comment instanceof BbComment)) {
      return;
    }
    const meta = this.meta.get(comment.thread);
    if (!meta) {
      return;
    }
    const hasReplies = (comment.data.comments?.length ?? 0) > 0;
    if (hasReplies) {
      void vscode.window.showWarningMessage('Bitbucket does not allow deleting a comment that has replies.');
      return;
    }
    const choice = await vscode.window.showWarningMessage('Delete this comment from the pull request?', { modal: true }, 'Delete');
    if (choice !== 'Delete') {
      return;
    }
    await this.runWrite(meta.model, () => meta.model.deleteComment(comment.data, meta.path));
  }

  /** `bitbucketPr.resolveTask` / `bitbucketPr.reopenTask` – acts on the task comment itself (root or reply). */
  async setTaskState(comment: BbComment, state: 'OPEN' | 'RESOLVED'): Promise<void> {
    if (!(comment instanceof BbComment)) {
      return;
    }
    const meta = this.meta.get(comment.thread);
    if (!meta || !isTask(comment.data)) {
      return;
    }
    await this.runWrite(meta.model, () => meta.model.setTaskState(comment.data, state, meta.path));
  }

  /** `bitbucketPr.copyCommentLink` */
  async copyCommentLink(comment: BbComment): Promise<void> {
    const url = this.commentUrl(comment);
    if (url) {
      await vscode.env.clipboard.writeText(url);
      void vscode.window.setStatusBarMessage('Bitbucket PR: comment link copied', 3000);
    }
  }

  /** `bitbucketPr.openCommentInBrowser` (thread title) */
  async openThreadInBrowser(thread: vscode.CommentThread): Promise<void> {
    const meta = this.meta.get(thread);
    if (!meta) {
      return;
    }
    await vscode.env.openExternal(vscode.Uri.parse(meta.model.client.commentUrl(meta.model.repo, meta.model.id, meta.root.id, meta.path)));
  }

  private commentUrl(comment: BbComment): string | undefined {
    if (!(comment instanceof BbComment)) {
      return undefined;
    }
    const meta = this.meta.get(comment.thread);
    if (!meta) {
      return undefined;
    }
    return meta.model.client.commentUrl(meta.model.repo, meta.model.id, comment.data.id, meta.path);
  }

  /** `bitbucketPr.goToComment` – from the tree view. */
  async goToComment(commentId: number, openOverview: () => Promise<void>): Promise<void> {
    const model = this.model;
    if (!model) {
      return;
    }
    const found = model.findComment(commentId);
    if (!found) {
      return;
    }
    if (!found.path) {
      await openOverview();
      return;
    }
    const cf = model.changeForPath(found.path);
    if (!cf) {
      return;
    }
    const fd = await model.loadFileDiff(found.path);
    const anchor = found.root.anchor;
    const pos = anchor ? displayLine(fd?.diff, anchor, anchor.lineType === 'REMOVED' || anchor.fileType === 'FROM' ? 'FROM' : 'TO') : undefined;
    await openPrDiff(model, cf, { line: pos?.line });
  }

  // ---------------------------------------------------------------- error handling

  private async runWrite(model: PrModel, action: () => Promise<unknown>): Promise<void> {
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Bitbucket PR' }, () => action());
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      log.error('Comment operation failed:', e);
      if (e instanceof BitbucketError && e.isPermissionProblem) {
        if (e.kind === 'forbidden') {
          this.access.markWriteForbidden();
        } else {
          void vscode.window.showErrorMessage(`Bitbucket PR: ${message}`, 'Sign In…').then((c) => {
            if (c === 'Sign In…') {
              void vscode.commands.executeCommand('bitbucketPr.signIn');
            }
          });
        }
        return;
      }
      if (e instanceof BitbucketError && e.kind === 'conflict') {
        void vscode.window.showWarningMessage('Bitbucket PR: the comment was changed on the server; reloaded the latest version.');
        await model.reload().catch(() => undefined);
        return;
      }
      void vscode.window.showErrorMessage(`Bitbucket PR: ${message}`);
    }
  }

  dispose(): void {
    this.modelListener?.dispose();
    for (const key of [...this.threadsByDoc.keys()]) {
      this.disposeThreadsFor(vscode.Uri.parse(key));
    }
    this.draftThreads.forEach((t) => t.dispose());
    this.disposables.forEach((d) => d.dispose());
  }
}
