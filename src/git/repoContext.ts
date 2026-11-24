import * as vscode from 'vscode';
import { parseBitbucketRemote, type ParsedRemote } from '../core/remoteParser';
import { log } from '../util/logger';
import { ContextKey, setContext } from '../util/contextKeys';
import { getGitApi, type GitAPI, type GitRepository } from './gitApi';

export interface RepoInfo {
  readonly repository: GitRepository;
  readonly remote: ParsedRemote;
  readonly remoteName: string;
}

export interface BranchState {
  readonly branch: string | undefined;
  readonly headCommit: string | undefined;
}

/**
 * Discovers git repositories with a Bitbucket remote and tracks the "current" one
 * (the repository containing the active editor, else the first one), its branch and HEAD.
 */
export class RepoContext implements vscode.Disposable {
  private readonly _onDidChangeCurrent = new vscode.EventEmitter<RepoInfo | undefined>();
  /** Fires when the current repository or its branch / HEAD changes. */
  readonly onDidChangeCurrent = this._onDidChangeCurrent.event;
  private readonly _onDidChangeWorkingTree = new vscode.EventEmitter<void>();
  /** Fires on any state change of the current repository (incl. working-tree changes). */
  readonly onDidChangeWorkingTree = this._onDidChangeWorkingTree.event;

  private git: GitAPI | undefined;
  private repos = new Map<string, RepoInfo>();
  private current: RepoInfo | undefined;
  private pinned: string | undefined;
  private lastBranchState: BranchState = { branch: undefined, headCommit: undefined };
  private readonly disposables: vscode.Disposable[] = [];
  private readonly repoListeners = new Map<string, vscode.Disposable>();

  async initialize(): Promise<void> {
    this.git = await getGitApi();
    if (!this.git) {
      log.warn('vscode.git extension not available');
      await setContext(ContextKey.hasRepo, false);
      return;
    }
    const git = this.git;
    this.disposables.push(
      git.onDidOpenRepository((r) => this.addRepository(r)),
      git.onDidCloseRepository((r) => this.removeRepository(r)),
      git.onDidChangeState(() => this.rescan()),
      vscode.window.onDidChangeActiveTextEditor(() => this.updateCurrent()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('bitbucketPr.serverUrl')) {
          this.rescan();
        }
      }),
    );
    this.rescan();
  }

  get currentRepo(): RepoInfo | undefined {
    return this.current;
  }

  get allRepos(): RepoInfo[] {
    return [...this.repos.values()];
  }

  get branchState(): BranchState {
    const head = this.current?.repository.state.HEAD;
    return { branch: head?.name, headCommit: head?.commit };
  }

  /** Repository info for a given file URI, if it is inside a tracked Bitbucket repository. */
  repoForUri(uri: vscode.Uri): RepoInfo | undefined {
    if (uri.scheme !== 'file') {
      return undefined;
    }
    let best: RepoInfo | undefined;
    for (const info of this.repos.values()) {
      const root = info.repository.rootUri.fsPath;
      if (uri.fsPath === root || uri.fsPath.startsWith(root.endsWith('/') ? root : root + '/')) {
        if (!best || root.length > best.repository.rootUri.fsPath.length) {
          best = info;
        }
      }
    }
    return best;
  }

  /**
   * Workspace file URI for a repository-relative path.
   * Rejects absolute paths and `..` segments so a PR path cannot point outside the repository.
   */
  fileUri(info: RepoInfo, repoPath: string): vscode.Uri | undefined {
    const segments = repoPath.split('/');
    if (
      info.repository.rootUri.scheme !== 'file'
      || repoPath.includes('\0')
      || repoPath.includes('\\')
      || segments.some((segment) => !segment || segment === '.' || segment === '..')
    ) {
      return undefined;
    }
    return vscode.Uri.joinPath(info.repository.rootUri, ...segments);
  }

  /** Path of `uri` relative to the repository root, using `/` separators. */
  relativePath(info: RepoInfo, uri: vscode.Uri): string | undefined {
    const root = info.repository.rootUri.fsPath.replace(/\/+$/, '');
    if (!uri.fsPath.startsWith(root + '/')) {
      return undefined;
    }
    return uri.fsPath.substring(root.length + 1).split('\\').join('/');
  }

  /** True when the file has uncommitted changes (index or working tree). */
  isFileDirty(info: RepoInfo, uri: vscode.Uri): boolean {
    const target = uri.fsPath;
    const changes = [...info.repository.state.workingTreeChanges, ...info.repository.state.indexChanges, ...info.repository.state.mergeChanges];
    return changes.some((c) => c.uri.fsPath === target || c.renameUri?.fsPath === target);
  }

  private rescan(): void {
    if (!this.git) {
      return;
    }
    for (const key of [...this.repos.keys()]) {
      const info = this.repos.get(key)!;
      if (!this.git.repositories.includes(info.repository)) {
        this.removeRepository(info.repository);
      }
    }
    for (const repo of this.git.repositories) {
      this.addRepository(repo);
    }
    this.updateCurrent();
  }

  private addRepository(repo: GitRepository): void {
    const key = repo.rootUri.toString();
    const info = this.describe(repo);
    const existing = this.repos.get(key);
    if (info) {
      this.repos.set(key, info);
      if (!existing) {
        log.info(`Tracking Bitbucket repository ${info.remote.projectKey}/${info.remote.repoSlug} at ${repo.rootUri.fsPath}`);
      }
    }
    // One state listener per repository, attached regardless of whether the remotes are known yet
    // (the git extension usually populates remotes shortly after opening the repository).
    if (!this.repoListeners.has(key)) {
      const stateListener = repo.state.onDidChange(() => {
        if (!this.repos.has(key)) {
          if (this.describe(repo)) {
            this.addRepository(repo);
            this.updateCurrent();
          }
          return;
        }
        if (this.current?.repository === repo) {
          this.handleCurrentStateChange();
        }
      });
      // Follow the git extension's selected repository (status bar / SCM view).
      const uiListener = repo.ui?.onDidChange?.(() => this.updateCurrent());
      this.repoListeners.set(key, {
        dispose: () => {
          stateListener.dispose();
          uiListener?.dispose();
        },
      });
    }
    void setContext(ContextKey.hasRepo, this.repos.size > 0);
  }

  private removeRepository(repo: GitRepository): void {
    const key = repo.rootUri.toString();
    this.repos.delete(key);
    this.repoListeners.get(key)?.dispose();
    this.repoListeners.delete(key);
    void setContext(ContextKey.hasRepo, this.repos.size > 0);
    this.updateCurrent();
  }

  private describe(repo: GitRepository): RepoInfo | undefined {
    const fallback = vscode.workspace.getConfiguration('bitbucketPr').get<string>('serverUrl');
    const remotes = repo.state.remotes;
    const ordered = [...remotes].sort((a, b) => (a.name === 'origin' ? -1 : b.name === 'origin' ? 1 : 0));
    for (const remote of ordered) {
      const url = remote.fetchUrl ?? remote.pushUrl;
      if (!url) {
        continue;
      }
      const parsed = parseBitbucketRemote(url, fallback);
      if (parsed) {
        return { repository: repo, remote: parsed, remoteName: remote.name };
      }
    }
    return undefined;
  }

  /** Pins the current repository explicitly (user choice); pass undefined to return to automatic selection. */
  pinRepository(info: RepoInfo | undefined): void {
    this.pinned = info?.repository.rootUri.toString();
    this.updateCurrent();
  }

  get isPinned(): boolean {
    return this.pinned !== undefined;
  }

  /**
   * Chooses the current repository. Priority:
   *  1. repository pinned by the user (while it is still open),
   *  2. repository selected in the git extension (the one whose branch is in the status bar),
   *  3. repository containing the active editor's file,
   *  4. repository that is (or contains) a workspace folder, in workspace-folder order,
   *  5. previously current repository, 6. first known repository.
   * This keeps stray repositories the git extension opened (parent folders, files from elsewhere)
   * from hijacking the PR shown for the workspace.
   */
  private updateCurrent(): void {
    let next: RepoInfo | undefined;
    if (this.pinned) {
      next = this.repos.get(this.pinned);
      if (!next) {
        this.pinned = undefined;
      }
    }
    // The repository the git extension itself shows in the status bar (multi-repo workspaces).
    if (!next) {
      next = [...this.repos.values()].find((r) => r.repository.ui?.selected);
    }
    const workspaceRepo = this.workspaceRepo();
    const active = vscode.window.activeTextEditor?.document.uri;
    if (!next && active) {
      const fromEditor = this.repoForUri(active);
      // A file from a repository outside the workspace must not hijack the PR shown for the workspace.
      if (fromEditor && (!workspaceRepo || this.isWorkspaceRepo(fromEditor))) {
        next = fromEditor;
      }
    }
    if (!next) {
      next = workspaceRepo;
    }
    if (!next && this.current && this.repos.has(this.current.repository.rootUri.toString())) {
      next = this.repos.get(this.current.repository.rootUri.toString());
    }
    if (!next) {
      next = this.repos.values().next().value as RepoInfo | undefined;
    }
    if (next?.repository !== this.current?.repository) {
      this.current = next;
      this.lastBranchState = this.branchState;
      log.info(
        next
          ? `Current repository: ${next.remote.projectKey}/${next.remote.repoSlug} (${next.repository.rootUri.fsPath})${this.pinned ? ' [pinned]' : ''}; known: ${this.repos.size}`
          : 'Current repository: none',
      );
      this._onDidChangeCurrent.fire(this.current);
    } else if (next && next !== this.current) {
      this.current = next; // refreshed info for same repository
    }
  }

  /** True when the repository is a workspace folder, contains one, or is nested inside one. */
  isWorkspaceRepo(info: RepoInfo): boolean {
    const root = info.repository.rootUri.fsPath.replace(/\/+$/, '');
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const folderPath = folder.uri.fsPath.replace(/\/+$/, '');
      if (folderPath === root || folderPath.startsWith(root + '/') || root.startsWith(folderPath + '/')) {
        return true;
      }
    }
    return false;
  }

  /** First repository (in workspace-folder order) whose root is a workspace folder or contains one. */
  private workspaceRepo(): RepoInfo | undefined {
    const folders = vscode.workspace.workspaceFolders ?? [];
    for (const folder of folders) {
      const folderPath = folder.uri.fsPath.replace(/\/+$/, '');
      let best: RepoInfo | undefined;
      for (const info of this.repos.values()) {
        const root = info.repository.rootUri.fsPath.replace(/\/+$/, '');
        const rootContainsFolder = folderPath === root || folderPath.startsWith(root + '/');
        if (rootContainsFolder && (!best || root.length > best.repository.rootUri.fsPath.length)) {
          best = info;
        }
      }
      if (best) {
        return best;
      }
      // Repository nested directly inside the workspace folder (e.g. folder/repo/.git).
      for (const info of this.repos.values()) {
        const root = info.repository.rootUri.fsPath.replace(/\/+$/, '');
        if (root.startsWith(folderPath + '/')) {
          return info;
        }
      }
    }
    return undefined;
  }

  private handleCurrentStateChange(): void {
    const state = this.branchState;
    if (state.branch !== this.lastBranchState.branch || state.headCommit !== this.lastBranchState.headCommit) {
      this.lastBranchState = state;
      this._onDidChangeCurrent.fire(this.current);
    }
    this._onDidChangeWorkingTree.fire();
  }

  dispose(): void {
    this._onDidChangeCurrent.dispose();
    this._onDidChangeWorkingTree.dispose();
    this.disposables.forEach((d) => d.dispose());
    this.repoListeners.forEach((d) => d.dispose());
  }
}
