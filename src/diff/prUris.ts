import * as vscode from 'vscode';
import type { Side } from '../core/anchorMapper';
import type { PrModel } from '../pr/prModel';

export const PR_FILE_SCHEME = 'bbpr';
export const PR_OVERVIEW_SCHEME = 'bbpr-overview';

export interface PrOverviewUriParts {
  /** Host only identifies the virtual document; providers always use the active model's client. */
  serverHost: string;
  projectKey: string;
  repoSlug: string;
  prId: number;
}

export interface PrFileUriParts extends PrOverviewUriParts {
  side: Side;
  /** Repository path of the file on that side. */
  path: string;
  /** Commit to read the file from; empty string means "file does not exist on this side". */
  commit: string;
}

export function prIdentityForModel(model: PrModel): PrOverviewUriParts {
  return {
    serverHost: new URL(model.client.baseUrl).host.toLowerCase(),
    projectKey: model.repo.projectKey,
    repoSlug: model.repo.repoSlug,
    prId: model.id,
  };
}

function hasActivePrIdentity(parts: PrOverviewUriParts, model: PrModel): boolean {
  const active = prIdentityForModel(model);
  return (
    parts.serverHost === active.serverHost
    && parts.projectKey === active.projectKey
    && parts.repoSlug === active.repoSlug
    && parts.prId === active.prId
  );
}

/** True only for a file URI generated for the active PR, changed path and side commit. */
export function isPrFileUriForModel(parts: PrFileUriParts, model: PrModel): boolean {
  if (!hasActivePrIdentity(parts, model)) {
    return false;
  }
  const file = model.changes.find((change) =>
    parts.side === 'FROM'
      ? (change.srcPath ?? change.path) === parts.path
      : change.path === parts.path,
  );
  if (!file) {
    return false;
  }
  if (!parts.commit) {
    return (parts.side === 'FROM' && file.change.type === 'ADD')
      || (parts.side === 'TO' && file.change.type === 'DELETE');
  }
  if (
    (parts.side === 'FROM' && file.change.type === 'ADD')
    || (parts.side === 'TO' && file.change.type === 'DELETE')
  ) {
    return false;
  }
  const diff = model.getLoadedDiff(file.path);
  const expectedCommit = parts.side === 'FROM'
    ? diff?.fromHash || model.targetCommit
    : diff?.toHash || model.sourceCommit;
  return parts.commit === expectedCommit;
}

/** True only for an overview URI generated for the active PR. */
export function isOverviewUriForModel(parts: PrOverviewUriParts, model: PrModel): boolean {
  return hasActivePrIdentity(parts, model);
}

export function makePrFileUri(p: PrFileUriParts): vscode.Uri {
  const query = new URLSearchParams({ at: p.commit }).toString();
  return vscode.Uri.from({
    scheme: PR_FILE_SCHEME,
    authority: p.serverHost,
    path: `/${encodeURIComponent(p.projectKey)}/${encodeURIComponent(p.repoSlug)}/${p.prId}/${p.side}/${p.path}`,
    query,
  });
}

export function parsePrFileUri(uri: vscode.Uri): PrFileUriParts | undefined {
  if (uri.scheme !== PR_FILE_SCHEME) {
    return undefined;
  }
  const segments = uri.path.split('/').filter(Boolean);
  if (segments.length < 5) {
    return undefined;
  }
  const [projectKey, repoSlug, prId, side, ...rest] = segments;
  if (side !== 'FROM' && side !== 'TO') {
    return undefined;
  }
  const params = new URLSearchParams(uri.query);
  const parsedPrId = Number(prId);
  if (!uri.authority || !Number.isSafeInteger(parsedPrId) || parsedPrId <= 0) {
    return undefined;
  }
  let decodedProjectKey: string;
  let decodedRepoSlug: string;
  try {
    decodedProjectKey = decodeURIComponent(projectKey);
    decodedRepoSlug = decodeURIComponent(repoSlug);
  } catch {
    return undefined;
  }
  return {
    serverHost: uri.authority.toLowerCase(),
    projectKey: decodedProjectKey,
    repoSlug: decodedRepoSlug,
    prId: parsedPrId,
    side,
    path: rest.join('/'),
    commit: params.get('at') ?? '',
  };
}

export function makeOverviewUri(p: PrOverviewUriParts): vscode.Uri {
  return vscode.Uri.from({
    scheme: PR_OVERVIEW_SCHEME,
    authority: p.serverHost,
    path: `/${encodeURIComponent(p.projectKey)}/${encodeURIComponent(p.repoSlug)}/${p.prId}/Pull Request #${p.prId}.md`,
  });
}

export function parseOverviewUri(uri: vscode.Uri): PrOverviewUriParts | undefined {
  if (uri.scheme !== PR_OVERVIEW_SCHEME) {
    return undefined;
  }
  const segments = uri.path.split('/').filter(Boolean);
  if (segments.length < 3) {
    return undefined;
  }
  const prId = Number(segments[2]);
  if (!uri.authority || !Number.isSafeInteger(prId) || prId <= 0) {
    return undefined;
  }
  let projectKey: string;
  let repoSlug: string;
  try {
    projectKey = decodeURIComponent(segments[0]);
    repoSlug = decodeURIComponent(segments[1]);
  } catch {
    return undefined;
  }
  return {
    serverHost: uri.authority.toLowerCase(),
    projectKey,
    repoSlug,
    prId,
  };
}
