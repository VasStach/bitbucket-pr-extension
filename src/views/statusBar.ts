import * as vscode from 'vscode';
import type { PrModel } from '../pr/prModel';
import type { PrResolver } from '../pr/prResolver';

/** Status bar item: `$(git-pull-request) #123 · $(tasklist) 4` (open tasks), or a sign-in prompt. */
export class PrStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];
  private modelListener: vscode.Disposable | undefined;

  constructor(private readonly resolver: PrResolver) {
    this.item = vscode.window.createStatusBarItem('bitbucketPr.status', vscode.StatusBarAlignment.Left, 90);
    this.item.name = 'Bitbucket Pull Request';
    this.disposables.push(
      this.item,
      resolver.onDidChangePr((m) => this.watch(m)),
      resolver.onDidChangeStatus(() => this.update()),
    );
    this.watch(resolver.current);
  }

  private watch(model: PrModel | undefined): void {
    this.modelListener?.dispose();
    this.modelListener = model?.onDidChange(() => this.update());
    this.update();
  }

  private update(): void {
    const repo = this.resolver.currentRepo;
    if (!repo) {
      this.item.hide();
      return;
    }
    const model = this.resolver.current;
    this.item.backgroundColor = undefined;
    if (!this.resolver.signedIn) {
      this.item.text = '$(sign-in) Bitbucket: Sign in';
      this.item.tooltip = `Sign in to ${repo.remote.host} with an HTTP access token`;
      this.item.command = 'bitbucketPr.signIn';
      this.item.show();
      return;
    }
    if (this.resolver.loading && !model) {
      this.item.text = '$(sync~spin) Bitbucket PR';
      this.item.tooltip = 'Looking for a pull request for the current branch…';
      this.item.command = undefined;
      this.item.show();
      return;
    }
    if (!model) {
      this.item.text = this.resolver.lastError ? '$(warning) Bitbucket PR' : '$(git-pull-request) No PR';
      this.item.tooltip = this.resolver.lastError ?? `No open pull request for ${repo.remote.projectKey}/${repo.remote.repoSlug} on this branch. Click to refresh.`;
      this.item.command = 'bitbucketPr.refresh';
      if (this.resolver.lastError) {
        this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      }
      this.item.show();
      return;
    }
    const openTasks = model.openTaskCount;
    const spin = model.loading ? '$(sync~spin) ' : '';
    this.item.text = `${spin}$(git-pull-request) #${model.id}${openTasks ? ` · $(tasklist) ${openTasks}` : ''}`;
    const md = new vscode.MarkdownString(`**${model.pr.title}**\n\n#${model.id} · ${model.pr.state} · \`${model.pr.fromRef.displayId}\` → \`${model.pr.toRef.displayId}\`\n\n${openTasks} open task(s). Click to open the overview.`);
    md.isTrusted = false;
    md.supportHtml = false;
    this.item.tooltip = md;
    this.item.command = 'bitbucketPr.openOverview';
    this.item.show();
  }

  dispose(): void {
    this.modelListener?.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}
