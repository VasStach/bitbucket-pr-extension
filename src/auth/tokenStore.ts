import * as vscode from 'vscode';
import { log } from '../util/logger';

const SECRET_PREFIX = 'bitbucketPr.token:';

/**
 * Stores one HTTP access token per Bitbucket host in VS Code SecretStorage.
 */
export class TokenStore implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<string>();
  /** Fires with the host whose token changed. */
  readonly onDidChange = this._onDidChange.event;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly secrets: vscode.SecretStorage) {
    this.disposables.push(
      secrets.onDidChange((e) => {
        if (e.key.startsWith(SECRET_PREFIX)) {
          this._onDidChange.fire(e.key.substring(SECRET_PREFIX.length));
        }
      }),
    );
  }

  private key(host: string): string {
    return SECRET_PREFIX + normalizeHost(host);
  }

  async getToken(host: string): Promise<string | undefined> {
    return this.secrets.get(this.key(host));
  }

  async hasToken(host: string): Promise<boolean> {
    return (await this.getToken(host)) !== undefined;
  }

  async setToken(host: string, token: string): Promise<void> {
    await this.secrets.store(this.key(host), token.trim());
    log.info(`Token stored for ${normalizeHost(host)}`);
  }

  async deleteToken(host: string): Promise<void> {
    await this.secrets.delete(this.key(host));
    log.info(`Token removed for ${normalizeHost(host)}`);
  }

  /** Prompts the user for a token and stores it. Returns true when a token was saved. */
  async promptSignIn(host: string): Promise<boolean> {
    const token = await vscode.window.showInputBox({
      title: `Bitbucket: Sign in to ${normalizeHost(host)}`,
      prompt: 'Paste an HTTP access token (Manage account → HTTP access tokens). Repository read gives read-only mode; write enables commenting.',
      password: true,
      ignoreFocusOut: true,
      placeHolder: 'HTTP access token',
      validateInput: (v) => (v.trim().length < 10 ? 'Token looks too short' : undefined),
    });
    if (!token) {
      return false;
    }
    await this.setToken(host, token);
    return true;
  }

  dispose(): void {
    this._onDidChange.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}

export function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
}
