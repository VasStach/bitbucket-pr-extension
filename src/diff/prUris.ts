import * as vscode from 'vscode';
import type { Side } from '../core/anchorMapper';

export const PR_FILE_SCHEME = 'bbpr';
export const PR_OVERVIEW_SCHEME = 'bbpr-overview';

export interface PrFileUriParts {
  baseUrl: string;
  projectKey: string;
  repoSlug: string;
  prId: number;
  side: Side;
  /** Repository path of the file on that side. */
  path: string;
  /** Commit to read the file from; empty string means "file does not exist on this side". */
  commit: string;
}

export interface PrOverviewUriParts {
  baseUrl: string;
  projectKey: string;
  repoSlug: string;
  prId: number;
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return 'bitbucket';
  }
}

export function makePrFileUri(p: PrFileUriParts): vscode.Uri {
  const query = new URLSearchParams({ at: p.commit, base: p.baseUrl }).toString();
  return vscode.Uri.from({
    scheme: PR_FILE_SCHEME,
    authority: hostOf(p.baseUrl),
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
  return {
    baseUrl: params.get('base') ?? `https://${uri.authority}`,
    projectKey: decodeURIComponent(projectKey),
    repoSlug: decodeURIComponent(repoSlug),
    prId: Number(prId),
    side,
    path: rest.join('/'),
    commit: params.get('at') ?? '',
  };
}

export function makeOverviewUri(p: PrOverviewUriParts): vscode.Uri {
  const query = new URLSearchParams({ base: p.baseUrl }).toString();
  return vscode.Uri.from({
    scheme: PR_OVERVIEW_SCHEME,
    authority: hostOf(p.baseUrl),
    path: `/${encodeURIComponent(p.projectKey)}/${encodeURIComponent(p.repoSlug)}/${p.prId}/Pull Request #${p.prId}.md`,
    query,
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
  const params = new URLSearchParams(uri.query);
  return {
    baseUrl: params.get('base') ?? `https://${uri.authority}`,
    projectKey: decodeURIComponent(segments[0]),
    repoSlug: decodeURIComponent(segments[1]),
    prId: Number(segments[2]),
  };
}
