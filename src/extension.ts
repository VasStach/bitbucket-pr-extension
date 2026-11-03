import * as vscode from 'vscode';
import { AccessState } from './auth/accessState';
import { TokenStore } from './auth/tokenStore';
import { BitbucketError } from './bitbucket/client';
import { ClientRegistry } from './bitbucket/clientRegistry';
import type { CommentSeverity } from './bitbucket/types';
import { BbComment, PrCommentController } from './comments/commentController';
import { openPrDiff } from './diff/openDiff';
import { PrFileContentProvider } from './diff/prContentProvider';
import { RepoContext } from './git/repoContext';
import type { PrModel } from './pr/prModel';
import { PrResolver } from './pr/prResolver';
import { log } from './util/logger';
import { OverviewDocumentProvider } from './views/overviewDocument';
import { PrTreeDataProvider, type PrTreeNode } from './views/prTreeView';
import { PrStatusBar } from './views/statusBar';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  log.info('Activating Bitbucket DC Pull Requests');

  const tokens = new TokenStore(context.secrets);
  const access = new AccessState();
  const clients = new ClientRegistry(tokens);
  const repoContext = new RepoContext();
  const resolver = new PrResolver(repoContext, tokens, clients, access);
  const fileProvider = new PrFileContentProvider(clients);
  const overview = new OverviewDocumentProvider(resolver);
  const comments = new PrCommentController(resolver, repoContext, access);
  const tree = new PrTreeDataProvider(resolver);
  const statusBar = new PrStatusBar(resolver);

  context.subscriptions.push(tokens, access, repoContext, resolver, fileProvider, overview, comments, tree, statusBar, { dispose: () => log.dispose() });

  const requireModel = (): PrModel | undefined => {
    const model = resolver.current;
    if (!model) {
      void vscode.window.showInformationMessage('Bitbucket PR: no open pull request for the current branch.');
    }
    return model;
  };

  const hostForSignIn = async (): Promise<string | undefined> => {
    const repo = repoContext.currentRepo;
    if (repo) {
      return repo.remote.host;
    }
    const fallback = vscode.workspace.getConfiguration('bitbucketPr').get<string>('serverUrl') ?? '';
    const input = await vscode.window.showInputBox({
      title: 'Bitbucket server',
      prompt: 'No Bitbucket repository detected in this workspace. Enter the server host to store a token for.',
      value: fallback,
      ignoreFocusOut: true,
    });
    if (!input) {
      return undefined;
    }
    try {
      return new URL(input.includes('://') ? input : `https://${input}`).host;
    } catch {
      return input;
    }
  };

  const register = (command: string, handler: (...args: any[]) => unknown) =>
    context.subscriptions.push(
      vscode.commands.registerCommand(command, async (...args: unknown[]) => {
        try {
          return await handler(...args);
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          log.error(`Command ${command} failed:`, e);
          void vscode.window.showErrorMessage(`Bitbucket PR: ${message}`);
          return undefined;
        }
      }),
    );

  // ---- account
  register('bitbucketPr.signIn', async () => {
    const host = await hostForSignIn();
    if (!host) {
      return;
    }
    const saved = await tokens.promptSignIn(host);
    if (!saved) {
      return;
    }
    access.reset();
    const repo = repoContext.currentRepo;
    if (repo && repo.remote.host === host) {
      try {
        await clients.get(repo.remote.baseUrl).validateToken();
        void vscode.window.showInformationMessage(`Bitbucket PR: signed in to ${host}.`);
      } catch (e) {
        if (e instanceof BitbucketError && e.kind === 'auth') {
          void vscode.window.showErrorMessage('Bitbucket PR: the token was rejected by the server (HTTP 401). Check that it is an HTTP access token for this server.');
        } else {
          log.warn(`Token validation call failed: ${(e as Error).message}`);
        }
      }
    }
    await resolver.refresh();
  });

  register('bitbucketPr.signOut', async () => {
    const repo = repoContext.currentRepo;
    const host = repo?.remote.host ?? (await hostForSignIn());
    if (!host) {
      return;
    }
    await tokens.deleteToken(host);
    access.reset();
    await resolver.refresh();
    void vscode.window.showInformationMessage(`Bitbucket PR: signed out from ${host}.`);
  });

  // ---- navigation
  register('bitbucketPr.refresh', () => resolver.refresh());

  register('bitbucketPr.selectRepository', async () => {
    const repos = repoContext.allRepos;
    if (repos.length === 0) {
      void vscode.window.showInformationMessage('Bitbucket PR: no Bitbucket repository detected in this workspace.');
      return;
    }
    const current = repoContext.currentRepo;
    const items: (vscode.QuickPickItem & { info?: import('./git/repoContext').RepoInfo })[] = repos.map((info) => ({
      label: `${info.remote.projectKey}/${info.remote.repoSlug}`,
      description: info.repository.state.HEAD?.name ?? '(detached)',
      detail: info.repository.rootUri.fsPath,
      picked: info.repository === current?.repository,
      info,
    }));
    if (repoContext.isPinned) {
      items.push({ label: '$(sync) Automatic', description: 'follow the repository selected in the git status bar / active editor' });
    }
    const pick = await vscode.window.showQuickPick(items, {
      title: 'Bitbucket PR: repository to show the pull request for',
      placeHolder: current ? `Current: ${current.remote.projectKey}/${current.remote.repoSlug}` : undefined,
    });
    if (!pick) {
      return;
    }
    repoContext.pinRepository(pick.info);
  });

  register('bitbucketPr.openInBrowser', () => {
    const model = requireModel();
    if (model) {
      return vscode.env.openExternal(vscode.Uri.parse(model.webUrl));
    }
    return undefined;
  });

  register('bitbucketPr.openOverview', () => {
    const model = requireModel();
    return model ? overview.open(model) : undefined;
  });

  register('bitbucketPr.openDiff', async (arg?: PrTreeNode | string) => {
    const model = requireModel();
    if (!model) {
      return;
    }
    const path = typeof arg === 'string' ? arg : arg?.file?.path;
    const file = path ? model.changeForPath(path) : undefined;
    if (!file) {
      const pick = await vscode.window.showQuickPick(
        model.changes.map((c) => ({ label: c.path, description: c.change.type, file: c })),
        { title: 'Open PR diff', placeHolder: 'Changed file' },
      );
      if (pick) {
        await openPrDiff(model, pick.file);
      }
      return;
    }
    await openPrDiff(model, file);
  });

  register('bitbucketPr.openLocalFile', async (node?: PrTreeNode) => {
    const repo = repoContext.currentRepo;
    const path = node?.file?.path;
    if (!repo || !path) {
      return;
    }
    const uri = vscode.Uri.joinPath(repo.repository.rootUri, ...path.split('/'));
    try {
      await vscode.window.showTextDocument(uri, { preview: true });
    } catch {
      void vscode.window.showWarningMessage(`Bitbucket PR: ${path} does not exist in the working tree.`);
    }
  });

  register('bitbucketPr.goToComment', (commentId: number) => {
    const model = resolver.current;
    return model ? comments.goToComment(commentId, () => overview.open(model)) : undefined;
  });

  // ---- comments
  const addGeneral = async (severity: CommentSeverity) => {
    const model = requireModel();
    if (!model) {
      return;
    }
    if (access.readOnly) {
      void vscode.window.showInformationMessage('Bitbucket PR: read-only mode – commenting is disabled.');
      return;
    }
    const noun = severity === 'BLOCKER' ? 'task' : 'comment';
    const text = await vscode.window.showInputBox({
      title: `Add general ${noun} to PR #${model.id}`,
      prompt: severity === 'BLOCKER' ? 'Tasks block the merge until resolved. Markdown is supported; posted immediately.' : 'Markdown is supported. The comment is posted immediately.',
      ignoreFocusOut: true,
      placeHolder: `${noun[0].toUpperCase()}${noun.slice(1)} text`,
    });
    if (!text?.trim()) {
      return;
    }
    try {
      await model.createGeneralComment(text.trim(), severity);
      await overview.open(model, true);
    } catch (e) {
      if (e instanceof BitbucketError && e.kind === 'forbidden') {
        access.markWriteForbidden();
        return;
      }
      throw e;
    }
  };
  register('bitbucketPr.addGeneralComment', () => addGeneral('NORMAL'));
  register('bitbucketPr.addGeneralTask', () => addGeneral('BLOCKER'));

  register('bitbucketPr.createThread', (reply: vscode.CommentReply) => comments.createThread(reply, 'NORMAL'));
  register('bitbucketPr.createTask', (reply: vscode.CommentReply) => comments.createThread(reply, 'BLOCKER'));
  register('bitbucketPr.replyThread', (reply: vscode.CommentReply) => comments.replyThread(reply, 'NORMAL'));
  register('bitbucketPr.replyTask', (reply: vscode.CommentReply) => comments.replyThread(reply, 'BLOCKER'));
  register('bitbucketPr.editComment', (comment: BbComment) => comments.editComment(comment));
  register('bitbucketPr.saveComment', (comment: BbComment) => comments.saveComment(comment));
  register('bitbucketPr.cancelEditComment', (comment: BbComment) => comments.cancelEditComment(comment));
  register('bitbucketPr.deleteComment', (comment: BbComment) => comments.deleteComment(comment));
  register('bitbucketPr.resolveTask', (comment: BbComment) => comments.setTaskState(comment, 'RESOLVED'));
  register('bitbucketPr.reopenTask', (comment: BbComment) => comments.setTaskState(comment, 'OPEN'));
  register('bitbucketPr.copyCommentLink', (comment: BbComment) => comments.copyCommentLink(comment));
  register('bitbucketPr.openCommentInBrowser', (thread: vscode.CommentThread) => comments.openThreadInBrowser(thread));

  // ---- start
  await repoContext.initialize();
  await resolver.resolve('activation');
  log.info('Bitbucket DC Pull Requests activated');
}

export function deactivate(): void {
  // Disposables are handled through context.subscriptions.
}
