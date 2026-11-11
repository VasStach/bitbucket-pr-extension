import * as vscode from 'vscode';
import type { PrResolver } from '../pr/prResolver';
import { log } from '../util/logger';
import { isPrFileUriForModel, parsePrFileUri, PR_FILE_SCHEME } from './prUris';

/**
 * Provides read-only content for `bbpr:` URIs: a repository file at a given commit, fetched via REST.
 * Content is immutable per (path, commit) so it is cached for the lifetime of the extension.
 */
export class PrFileContentProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;
  private readonly cache = new Map<string, string>();
  private readonly registration: vscode.Disposable;

  constructor(private readonly resolver: PrResolver) {
    this.registration = vscode.workspace.registerTextDocumentContentProvider(PR_FILE_SCHEME, this);
  }

  async provideTextDocumentContent(uri: vscode.Uri, token: vscode.CancellationToken): Promise<string> {
    const parts = parsePrFileUri(uri);
    const model = this.resolver.current;
    if (!parts || !model || !isPrFileUriForModel(parts, model)) {
      return '';
    }
    if (!parts.commit) {
      return ''; // file does not exist on this side (added / deleted file)
    }
    const key = `${parts.serverHost}|${parts.projectKey}|${parts.repoSlug}|${parts.commit}|${parts.path}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    try {
      const content = await model.client.getRawFile(model.repo, parts.path, parts.commit);
      if (token.isCancellationRequested) {
        return '';
      }
      const text = content ?? '';
      this.cache.set(key, text);
      return text;
    } catch (e) {
      log.error(`Could not load ${parts.path}@${parts.commit.substring(0, 10)}`, e);
      void vscode.window.showErrorMessage(`Bitbucket PR: could not load ${parts.path}: ${(e as Error).message}`);
      return '';
    }
  }

  clearCache(): void {
    this.cache.clear();
  }

  dispose(): void {
    this.registration.dispose();
    this._onDidChange.dispose();
  }
}
