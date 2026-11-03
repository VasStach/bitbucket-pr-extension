/**
 * Minimal subset of the built-in `vscode.git` extension API (git.d.ts) used by this extension.
 */
import type { Event, Extension, Uri, extensions as vsExtensions } from 'vscode';
import * as vscode from 'vscode';

export const enum GitStatus {
  INDEX_MODIFIED = 0,
  INDEX_ADDED = 1,
  INDEX_DELETED = 2,
  INDEX_RENAMED = 3,
  INDEX_COPIED = 4,
  MODIFIED = 5,
  DELETED = 6,
  UNTRACKED = 7,
  IGNORED = 8,
  INTENT_TO_ADD = 9,
  INTENT_TO_RENAME = 10,
  TYPE_CHANGED = 11,
  ADDED_BY_US = 12,
  ADDED_BY_THEM = 13,
  DELETED_BY_US = 14,
  DELETED_BY_THEM = 15,
  BOTH_ADDED = 16,
  BOTH_DELETED = 17,
  BOTH_MODIFIED = 18,
}

export interface GitChange {
  readonly uri: Uri;
  readonly originalUri: Uri;
  readonly renameUri: Uri | undefined;
  readonly status: GitStatus;
}

export interface GitRef {
  readonly type: number;
  readonly name?: string;
  readonly commit?: string;
  readonly remote?: string;
}

export interface GitBranch extends GitRef {
  readonly upstream?: { readonly remote: string; readonly name: string };
  readonly ahead?: number;
  readonly behind?: number;
}

export interface GitRemote {
  readonly name: string;
  readonly fetchUrl?: string;
  readonly pushUrl?: string;
  readonly isReadOnly: boolean;
}

export interface GitRepositoryState {
  readonly HEAD: GitBranch | undefined;
  readonly refs: GitRef[];
  readonly remotes: GitRemote[];
  readonly workingTreeChanges: GitChange[];
  readonly indexChanges: GitChange[];
  readonly mergeChanges: GitChange[];
  readonly onDidChange: Event<void>;
}

export interface GitRepositoryUIState {
  /** True for the repository the git extension currently shows in the status bar / SCM view. */
  readonly selected: boolean;
  readonly onDidChange: Event<void>;
}

export interface GitRepository {
  readonly rootUri: Uri;
  readonly state: GitRepositoryState;
  readonly ui: GitRepositoryUIState;
  getConfig(key: string): Promise<string>;
  show(ref: string, path: string): Promise<string>;
  getCommit(ref: string): Promise<{ hash: string; message: string }>;
  fetch(options?: { remote?: string; ref?: string; depth?: number }): Promise<void>;
}

export interface GitAPI {
  readonly state: 'uninitialized' | 'initialized';
  readonly onDidChangeState: Event<'uninitialized' | 'initialized'>;
  readonly repositories: GitRepository[];
  readonly onDidOpenRepository: Event<GitRepository>;
  readonly onDidCloseRepository: Event<GitRepository>;
  getRepository(uri: Uri): GitRepository | null;
}

export interface GitExtension {
  readonly enabled: boolean;
  readonly onDidChangeEnablement: Event<boolean>;
  getAPI(version: 1): GitAPI;
}

export async function getGitApi(extensions: typeof vsExtensions = vscode.extensions): Promise<GitAPI | undefined> {
  const ext = extensions.getExtension<GitExtension>('vscode.git') as Extension<GitExtension> | undefined;
  if (!ext) {
    return undefined;
  }
  const gitExtension = ext.isActive ? ext.exports : await ext.activate();
  if (!gitExtension?.enabled) {
    return undefined;
  }
  return gitExtension.getAPI(1);
}
