import * as vscode from 'vscode';
import type { AccessState } from '../auth/accessState';
import type { TokenStore } from '../auth/tokenStore';
import { BitbucketError } from '../bitbucket/client';
import type { ClientRegistry } from '../bitbucket/clientRegistry';
import type { RepoContext, RepoInfo } from '../git/repoContext';
import { ContextKey, setContext } from '../util/contextKeys';
import { log } from '../util/logger';
import { PrModel } from './prModel';

/**
 * Finds the open pull request for the current branch and keeps a PrModel for it.
 * Re-resolves on branch/HEAD/repository change, on sign-in/out, on manual refresh and on a poll interval.
 */
export class PrResolver implements vscode.Disposable {
  private readonly _onDidChangePr = new vscode.EventEmitter<PrModel | undefined>();
  /** Fires when the current PR model is replaced (new PR, no PR, signed out). */
  readonly onDidChangePr = this._onDidChangePr.event;
  private readonly _onDidChangeStatus = new vscode.EventEmitter<void>();
  /** Fires on loading / error / signed-in state changes. */
  readonly onDidChangeStatus = this._onDidChangeStatus.event;

  private model: PrModel | undefined;
  private _signedIn = false;
  private _loading = false;
  private _lastError: string | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private resolveSeq = 0;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly repoContext: RepoContext,
    private readonly tokens: TokenStore,
    private readonly clients: ClientRegistry,
    access: AccessState,
  ) {
    this.disposables.push(
      repoContext.onDidChangeCurrent(() => void this.resolve('repository/branch changed')),
      tokens.onDidChange(() => {
        access.reset();
        void this.resolve('token changed');
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('bitbucketPr.refreshIntervalSeconds')) {
          this.setupTimer();
        }
      }),
    );
    this.setupTimer();
  }

  get current(): PrModel | undefined {
    return this.model;
  }

  get signedIn(): boolean {
    return this._signedIn;
  }

  get loading(): boolean {
    return this._loading;
  }

  get lastError(): string | undefined {
    return this._lastError;
  }

  get currentRepo(): RepoInfo | undefined {
    return this.repoContext.currentRepo;
  }

  /** Fires when the current repository (or its branch/HEAD) changes. */
  get onDidChangeRepo(): vscode.Event<RepoInfo | undefined> {
    return this.repoContext.onDidChangeCurrent;
  }

  /** Manual refresh: re-resolve the PR for the branch and reload everything. */
  async refresh(): Promise<void> {
    await this.resolve('manual refresh');
  }

  private setupTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    const seconds = vscode.workspace.getConfiguration('bitbucketPr').get<number>('refreshIntervalSeconds', 60);
    if (seconds > 0) {
      this.timer = setInterval(() => void this.poll(), Math.max(10, seconds) * 1000);
    }
  }

  private async poll(): Promise<void> {
    if (this._loading || !this._signedIn) {
      return;
    }
    if (this.model) {
      try {
        await this.model.reload();
        this._lastError = undefined;
      } catch (e) {
        this.handleError(e, 'poll');
      }
      this._onDidChangeStatus.fire();
    } else {
      await this.resolve('poll');
    }
  }

  async resolve(reason: string): Promise<void> {
    const seq = ++this.resolveSeq;
    const repo = this.repoContext.currentRepo;
    const { branch } = this.repoContext.branchState;
    this._loading = true;
    this._lastError = undefined;
    await setContext(ContextKey.loading, true);
    this._onDidChangeStatus.fire();
    try {
      if (!repo) {
        this._signedIn = false;
        await setContext(ContextKey.signedIn, false);
        this.setModel(undefined);
        return;
      }
      const token = await this.tokens.getToken(repo.remote.host);
      this._signedIn = !!token;
      await setContext(ContextKey.signedIn, this._signedIn);
      if (!token) {
        this.setModel(undefined);
        return;
      }
      if (!branch) {
        log.info(`No branch checked out (detached HEAD?) – ${reason}`);
        this.setModel(undefined);
        return;
      }
      const client = this.clients.get(repo.remote.baseUrl);
      const coords = { projectKey: repo.remote.projectKey, repoSlug: repo.remote.repoSlug };
      log.info(`Resolving PR for ${coords.projectKey}/${coords.repoSlug}@${branch} (${reason})`);
      const prs = await client.findOpenPullRequestsForBranch(coords, branch);
      if (seq !== this.resolveSeq) {
        return; // superseded
      }
      if (prs.length === 0) {
        log.info('No open pull request for branch');
        this.setModel(undefined);
        return;
      }
      // Prefer PR with most recent update when several exist (e.g. into multiple targets).
      const pr = prs.slice().sort((a, b) => b.updatedDate - a.updatedDate)[0];
      if (this.model && this.model.id === pr.id && this.model.client === client) {
        await this.model.reload();
      } else {
        const model = new PrModel(client, coords, pr);
        this.setModel(model);
        await model.reload();
      }
      if (seq !== this.resolveSeq) {
        return;
      }
      log.info(`Resolved PR #${pr.id}: ${pr.title}`);
    } catch (e) {
      if (seq === this.resolveSeq) {
        this.handleError(e, reason);
        if (e instanceof BitbucketError && e.kind === 'auth') {
          this.setModel(undefined);
        }
      }
    } finally {
      if (seq === this.resolveSeq) {
        this._loading = false;
        await setContext(ContextKey.loading, false);
        this._onDidChangeStatus.fire();
      }
    }
  }

  private handleError(e: unknown, context: string): void {
    const message = e instanceof Error ? e.message : String(e);
    this._lastError = message;
    log.error(`Failed (${context}):`, e);
    if (e instanceof BitbucketError && e.kind === 'auth') {
      void vscode.window
        .showErrorMessage('Bitbucket PR: authentication failed. The access token is invalid or expired.', 'Sign In…')
        .then((choice) => {
          if (choice === 'Sign In…') {
            void vscode.commands.executeCommand('bitbucketPr.signIn');
          }
        });
    }
  }

  private setModel(model: PrModel | undefined): void {
    if (this.model === model) {
      return;
    }
    this.model?.dispose();
    this.model = model;
    void setContext(ContextKey.hasPr, !!model);
    this._onDidChangePr.fire(model);
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
    this.model?.dispose();
    this._onDidChangePr.dispose();
    this._onDidChangeStatus.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}
