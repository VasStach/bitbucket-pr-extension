import * as vscode from 'vscode';
import { ContextKey, setContext } from '../util/contextKeys';
import { log } from '../util/logger';

/**
 * Tracks whether write operations are allowed.
 *
 * Bitbucket has no cheap "what can this token do" endpoint, so we are optimistic:
 * writes are enabled until the first 401/403 from a write call, after which the
 * extension switches to read-only mode until the user signs in/out again.
 * The `bitbucketPr.readOnly` setting forces read-only mode.
 */
export class AccessState implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;
  private detectedReadOnly = false;
  private notified = false;
  private readonly disposables: vscode.Disposable[] = [];

  constructor() {
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('bitbucketPr.readOnly')) {
          void this.apply();
        }
      }),
    );
    void this.apply();
  }

  private get forcedReadOnly(): boolean {
    return vscode.workspace.getConfiguration('bitbucketPr').get<boolean>('readOnly', false);
  }

  get readOnly(): boolean {
    return this.forcedReadOnly || this.detectedReadOnly;
  }

  /** Call when a write request failed with 401/403. */
  markWriteForbidden(): void {
    if (this.detectedReadOnly) {
      return;
    }
    this.detectedReadOnly = true;
    log.warn('Write operation forbidden; switching to read-only mode');
    if (!this.notified) {
      this.notified = true;
      void vscode.window.showInformationMessage(
        'Bitbucket PR: the access token has read permission only. Creating and editing comments is disabled. Sign in with a token that has repository write permission to enable it.',
      );
    }
    void this.apply();
  }

  /** Call after sign-in / sign-out to re-enable the optimistic write mode. */
  reset(): void {
    this.detectedReadOnly = false;
    this.notified = false;
    void this.apply();
  }

  private async apply(): Promise<void> {
    await setContext(ContextKey.readOnly, this.readOnly);
    this._onDidChange.fire();
  }

  dispose(): void {
    this._onDidChange.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}
