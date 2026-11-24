import * as vscode from 'vscode';
import type { ChangeType, Comment } from '../bitbucket/types';
import { countTasks, isResolvedTask, isTask, isWholeFileComment, partitionComments } from '../core/commentState';
import type { ChangedFile, PrModel } from '../pr/prModel';
import type { PrResolver } from '../pr/prResolver';

type NodeKind = 'header' | 'info' | 'filesGroup' | 'file' | 'generalGroup' | 'comment' | 'message';

export class PrTreeNode extends vscode.TreeItem {
  constructor(
    readonly kind: NodeKind,
    label: string,
    collapsible: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.None,
    readonly file?: ChangedFile,
    readonly comment?: Comment,
  ) {
    super(label, collapsible);
  }
}

export class PrTreeDataProvider implements vscode.TreeDataProvider<PrTreeNode>, vscode.Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<PrTreeNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private readonly disposables: vscode.Disposable[] = [];
  private modelListener: vscode.Disposable | undefined;
  private readonly view: vscode.TreeView<PrTreeNode>;

  constructor(private readonly resolver: PrResolver) {
    this.view = vscode.window.createTreeView('bitbucketPr.prView', { treeDataProvider: this, showCollapseAll: true });
    this.disposables.push(
      this.view,
      resolver.onDidChangePr((m) => this.watch(m)),
      resolver.onDidChangeStatus(() => this.refresh()),
      resolver.onDidChangeRepo(() => this.refresh()),
    );
    this.watch(resolver.current);
  }

  private watch(model: PrModel | undefined): void {
    this.modelListener?.dispose();
    this.modelListener = model?.onDidChange(() => this.refresh());
    this.refresh();
  }

  refresh(): void {
    const model = this.resolver.current;
    const repo = this.resolver.currentRepo;
    this.view.title = model ? `Pull Request #${model.id}` : 'Pull Request';
    this.view.description = model ? `${repo?.remote.repoSlug ?? ''} · ${model.pr.fromRef.displayId}` : repo ? `${repo.remote.projectKey}/${repo.remote.repoSlug}` : undefined;
    const openTasks = model?.openTaskCount ?? 0;
    this.view.badge = model && openTasks > 0 ? { value: openTasks, tooltip: `${openTasks} open task(s)` } : undefined;
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: PrTreeNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: PrTreeNode): PrTreeNode[] {
    const model = this.resolver.current;
    if (!model) {
      if (this.resolver.lastError) {
        const n = new PrTreeNode('message', 'Could not load pull request');
        n.description = this.resolver.lastError;
        n.tooltip = this.resolver.lastError;
        n.iconPath = new vscode.ThemeIcon('warning');
        n.command = { command: 'bitbucketPr.refresh', title: 'Retry' };
        return element ? [] : [n];
      }
      return [];
    }
    if (!element) {
      return this.rootNodes(model);
    }
    switch (element.kind) {
      case 'header':
        return this.headerChildren(model);
      case 'filesGroup':
        return model.changes.map((f) => this.fileNode(f));
      case 'file':
        return element.file ? this.fileComments(model, element.file) : [];
      case 'generalGroup':
        return model.generalComments.map((c) => this.commentNode(c));
      default:
        return [];
    }
  }

  private rootNodes(model: PrModel): PrTreeNode[] {
    const pr = model.pr;
    const header = new PrTreeNode('header', pr.title, vscode.TreeItemCollapsibleState.Expanded);
    header.description = `#${pr.id} · ${pr.state}${pr.draft ? ' · draft' : ''}`;
    header.tooltip = untrustedMarkdown(`**${pr.title}**\n\n#${pr.id} by ${pr.author.user.displayName}\n\n\`${pr.fromRef.displayId}\` → \`${pr.toRef.displayId}\``);
    header.iconPath = new vscode.ThemeIcon('git-pull-request');
    header.contextValue = 'bitbucketPr.header';
    header.command = { command: 'bitbucketPr.openOverview', title: 'Open Overview' };

    const files = new PrTreeNode('filesGroup', 'Changed files', vscode.TreeItemCollapsibleState.Expanded);
    files.description = String(model.changes.length);
    files.iconPath = new vscode.ThemeIcon('files');
    files.contextValue = 'bitbucketPr.filesGroup';

    const general = new PrTreeNode('generalGroup', 'General comments', vscode.TreeItemCollapsibleState.Expanded);
    const generalTasks = countTasks(model.generalComments);
    general.description = generalTasks.open ? `${model.generalComments.length} · ${generalTasks.open} open task${generalTasks.open === 1 ? '' : 's'}` : String(model.generalComments.length);
    general.iconPath = new vscode.ThemeIcon('comment-discussion');
    general.contextValue = 'bitbucketPr.generalGroup';

    return [header, files, general];
  }

  private headerChildren(model: PrModel): PrTreeNode[] {
    const pr = model.pr;
    const out: PrTreeNode[] = [];
    const branch = new PrTreeNode('info', `${pr.fromRef.displayId} → ${pr.toRef.displayId}`);
    branch.iconPath = new vscode.ThemeIcon('git-branch');
    branch.tooltip = `Source ${pr.fromRef.latestCommit.substring(0, 10)} → target ${pr.toRef.latestCommit.substring(0, 10)}`;
    out.push(branch);

    const author = new PrTreeNode('info', pr.author.user.displayName);
    author.description = 'author';
    author.iconPath = new vscode.ThemeIcon('account');
    out.push(author);

    for (const r of pr.reviewers) {
      const n = new PrTreeNode('info', r.user.displayName);
      n.description = r.approved ? 'approved' : r.status === 'NEEDS_WORK' ? 'needs work' : 'reviewer';
      n.iconPath = new vscode.ThemeIcon(r.approved ? 'check' : r.status === 'NEEDS_WORK' ? 'request-changes' : 'person');
      out.push(n);
    }
    const open = new PrTreeNode('info', 'Open in Bitbucket');
    open.iconPath = new vscode.ThemeIcon('link-external');
    open.command = { command: 'bitbucketPr.openInBrowser', title: 'Open in Browser' };
    out.push(open);
    return out;
  }

  private fileNode(f: ChangedFile): PrTreeNode {
    const name = f.path.split('/').pop() ?? f.path;
    const dir = f.path.includes('/') ? f.path.substring(0, f.path.lastIndexOf('/')) : '';
    const node = new PrTreeNode('file', name, f.commentCount > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None, f);
    const badge = (f.commentCount > 0 ? ` $(comment) ${f.commentCount}` : '') + (f.openTaskCount > 0 ? ` $(tasklist) ${f.openTaskCount}` : '');
    node.description = `${dir}${badge}`;
    node.resourceUri = vscode.Uri.parse(`bbpr-tree:/${f.path}`);
    node.iconPath = iconForChange(f.change.type);
    node.tooltip = `${f.path}\n${describeChange(f.change.type)}${f.srcPath ? ` (from ${f.srcPath})` : ''}${f.commentCount ? `\n${f.commentCount} comment thread(s), ${f.openTaskCount} open task(s)` : ''}`;
    node.contextValue = 'bitbucketPr.file';
    node.command = { command: 'bitbucketPr.openDiff', title: 'Open Diff', arguments: [node] };
    return node;
  }

  private fileComments(model: PrModel, f: ChangedFile): PrTreeNode[] {
    const fd = model.getLoadedDiff(f.path);
    if (!fd) {
      void model.loadFileDiff(f.path).then(() => this.refresh());
      const n = new PrTreeNode('message', 'Loading comments…');
      n.iconPath = new vscode.ThemeIcon('loading~spin');
      return [n];
    }
    const split = partitionComments(fd.lineComments, fd.fileComments);
    return [...split.lines, ...split.files].map((c) => this.commentNode(c, true));
  }

  private commentNode(c: Comment, inline = false): PrTreeNode {
    const firstLine = (c.text ?? '').split('\n').find((l) => l.trim()) ?? '';
    const replies = countReplies(c);
    const task = isTask(c);
    const prefix = task ? (isResolvedTask(c) ? '☑ ' : '☐ ') : '';
    const node = new PrTreeNode('comment', `${prefix}${c.author.displayName}: ${firstLine.length > 80 ? firstLine.slice(0, 80) + '…' : firstLine}`, vscode.TreeItemCollapsibleState.None, undefined, c);
    const parts: string[] = [];
    const nested = countTasks(c.comments ?? []);
    if (nested.open) {
      parts.push(`${nested.open} open task${nested.open === 1 ? '' : 's'} in replies`);
    }
    if (inline && c.anchor?.line !== undefined && c.anchor.line >= 1) {
      parts.push(`L${c.anchor.line}`);
    } else if (inline && isWholeFileComment(c)) {
      parts.push('whole file');
    }
    if (replies) {
      parts.push(`${replies} repl${replies === 1 ? 'y' : 'ies'}`);
    }
    parts.push(new Date(c.createdDate).toLocaleDateString());
    node.description = parts.join(' · ');
    node.iconPath = task
      ? new vscode.ThemeIcon(isResolvedTask(c) ? 'pass' : 'tasklist', isResolvedTask(c) ? new vscode.ThemeColor('testing.iconPassed') : new vscode.ThemeColor('list.warningForeground'))
      : new vscode.ThemeIcon('comment');
    node.tooltip = untrustedMarkdown(c.text);
    node.contextValue = 'bitbucketPr.comment';
    node.command = { command: 'bitbucketPr.goToComment', title: 'Go to Comment', arguments: [c.id] };
    return node;
  }

  dispose(): void {
    this.modelListener?.dispose();
    this._onDidChangeTreeData.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}

function untrustedMarkdown(value: string): vscode.MarkdownString {
  const markdown = new vscode.MarkdownString(value);
  markdown.isTrusted = false;
  markdown.supportHtml = false;
  return markdown;
}

function countReplies(c: Comment): number {
  let n = 0;
  for (const r of c.comments ?? []) {
    n += 1 + countReplies(r);
  }
  return n;
}

function iconForChange(type: ChangeType): vscode.ThemeIcon {
  switch (type) {
    case 'ADD':
      return new vscode.ThemeIcon('diff-added', new vscode.ThemeColor('gitDecoration.addedResourceForeground'));
    case 'DELETE':
      return new vscode.ThemeIcon('diff-removed', new vscode.ThemeColor('gitDecoration.deletedResourceForeground'));
    case 'MOVE':
    case 'RENAME':
      return new vscode.ThemeIcon('diff-renamed', new vscode.ThemeColor('gitDecoration.renamedResourceForeground'));
    case 'COPY':
      return new vscode.ThemeIcon('files', new vscode.ThemeColor('gitDecoration.addedResourceForeground'));
    default:
      return new vscode.ThemeIcon('diff-modified', new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'));
  }
}

function describeChange(type: ChangeType): string {
  switch (type) {
    case 'ADD':
      return 'Added';
    case 'DELETE':
      return 'Deleted';
    case 'MOVE':
      return 'Moved';
    case 'RENAME':
      return 'Renamed';
    case 'COPY':
      return 'Copied';
    case 'MODIFY':
      return 'Modified';
    default:
      return 'Changed';
  }
}
