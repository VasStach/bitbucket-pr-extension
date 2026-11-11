import * as vscode from 'vscode';
import type { PullRequest } from '../bitbucket/types';
import { isOverviewUriForModel, makeOverviewUri, parseOverviewUri, prIdentityForModel, PR_OVERVIEW_SCHEME } from '../diff/prUris';
import type { PrModel } from '../pr/prModel';
import type { PrResolver } from '../pr/prResolver';

/**
 * Read-only Markdown document describing the current PR. General comment threads are attached
 * to this document by the comment controller, so the native comment UI is reused for them.
 */
export class OverviewDocumentProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;
  private readonly disposables: vscode.Disposable[] = [];
  private modelListener: vscode.Disposable | undefined;

  constructor(private readonly resolver: PrResolver) {
    this.disposables.push(
      vscode.workspace.registerTextDocumentContentProvider(PR_OVERVIEW_SCHEME, this),
      resolver.onDidChangePr((m) => this.watch(m)),
    );
    this.watch(resolver.current);
  }

  private lastRendered: string | undefined;

  private watch(model: PrModel | undefined): void {
    this.modelListener?.dispose();
    this.lastRendered = undefined;
    this.modelListener = model?.onDidChange(() => {
      // Only re-render when the visible content actually changed (re-rendering disturbs focus / scroll).
      const next = renderOverview(model.pr, model.webUrl, model.changes.length);
      if (next !== this.lastRendered) {
        this._onDidChange.fire(uriFor(model));
      }
    });
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    const parts = parseOverviewUri(uri);
    const model = this.resolver.current;
    if (!parts || !model || !isOverviewUriForModel(parts, model)) {
      return `# Pull request #${parts?.prId ?? '?'}\n\nThis pull request is not the one associated with the current branch.\n`;
    }
    this.lastRendered = renderOverview(model.pr, model.webUrl, model.changes.length);
    return this.lastRendered;
  }

  async open(model: PrModel, preserveFocus = false): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(uriFor(model));
    await vscode.window.showTextDocument(doc, { preview: true, preserveFocus });
  }

  dispose(): void {
    this.modelListener?.dispose();
    this._onDidChange.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}

export function uriFor(model: PrModel): vscode.Uri {
  return makeOverviewUri(prIdentityForModel(model));
}

function renderOverview(pr: PullRequest, url: string, changedFiles: number): string {
  const reviewers = pr.reviewers.length
    ? pr.reviewers.map((r) => `- ${r.user.displayName}${r.approved ? ' ✔ approved' : r.status === 'NEEDS_WORK' ? ' ✎ needs work' : ''}`).join('\n')
    : '- (none)';
  const lines = [
    `# ${pr.title}`,
    '',
    `**#${pr.id}** · ${pr.state}${pr.draft ? ' (draft)' : ''} · by ${pr.author.user.displayName}`,
    '',
    `\`${pr.fromRef.displayId}\` → \`${pr.toRef.displayId}\` · ${changedFiles} changed file${changedFiles === 1 ? '' : 's'}`,
    '',
    `Created ${new Date(pr.createdDate).toLocaleString()} · Updated ${new Date(pr.updatedDate).toLocaleString()}`,
    '',
    `[Open in Bitbucket](${url})`,
    '',
    '## Reviewers',
    '',
    reviewers,
    '',
    '## Description',
    '',
    (pr.description ?? '').trim() || '_No description._',
    '',
    '---',
    '',
    '## Comments',
    '',
    'General comments and tasks are shown below. Use the comment action on the last line (Create Task / Create Comment), or "Bitbucket PR: Add General Task…" / "Add General Comment…".',
    '',
  ];
  return lines.join('\n');
}
