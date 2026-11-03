import * as vscode from 'vscode';
import type { ClientRegistry } from '../bitbucket/clientRegistry';
import { log } from '../util/logger';
import { parsePrFileUri, PR_FILE_SCHEME } from './prUris';

/**
 * Provides read-only content for `bbpr:` URIs: a repository file at a given commit, fetched via REST.
 * Content is immutable per (path, commit) so it is cached for the lifetime of the extension.
 */
export class PrFileContentProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;
  private readonly cache = new Map<string, string>();
  private readonly registration: vscode.Disposable;

  constructor(private readonly clients: ClientRegistry) {
    this.registration = vscode.workspace.registerTextDocumentContentProvider(PR_FILE_SCHEME, this);
  }

  async provideTextDocumentContent(uri: vscode.Uri, token: vscode.CancellationToken): Promise<string> {
    const parts = parsePrFileUri(uri);
    if (!parts) {
      return '';
    }
    if (!parts.commit) {
      return ''; // file does not exist on this side (added / deleted file)
    }
    const key = `${parts.baseUrl}|${parts.projectKey}|${parts.repoSlug}|${parts.commit}|${parts.path}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const client = this.clients.get(parts.baseUrl);
    try {
      const content = await client.getRawFile({ projectKey: parts.projectKey, repoSlug: parts.repoSlug }, parts.path, parts.commit);
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
