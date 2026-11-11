import type {
  Activity,
  BbUser,
  Change,
  Comment,
  CreateCommentRequest,
  DiffResponse,
  Page,
  PullRequest,
  UpdateCommentRequest,
} from './types';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class BitbucketError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly kind: 'auth' | 'forbidden' | 'notFound' | 'conflict' | 'badRequest' | 'server' | 'network' | 'other',
    readonly serverMessage?: string,
  ) {
    super(message);
    this.name = 'BitbucketError';
  }

  /** True when the token is missing/invalid or lacks permission for the request. */
  get isPermissionProblem(): boolean {
    return this.kind === 'auth' || this.kind === 'forbidden';
  }
}

export interface RepoCoords {
  projectKey: string;
  repoSlug: string;
}

export interface ClientOptions {
  /** e.g. https://bitbucket.example.com (no trailing slash). */
  baseUrl: string;
  /** Returns the current token or undefined when signed out. */
  getToken: () => Promise<string | undefined>;
  fetchImpl?: FetchLike;
}

interface ServerErrorBody {
  errors?: { message?: string; exceptionName?: string }[];
}

function toQuery(params: Record<string, string | number | boolean | undefined>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) {
      continue;
    }
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

/** Encodes a repository path for use inside a URL path segment list (keeps `/`). */
export function encodePath(path: string): string {
  return path
    .split('/')
    .map((p) => encodeURIComponent(p))
    .join('/');
}

/**
 * Thin Bitbucket Data Center REST client (API 1.0 / latest).
 * Uses `Authorization: Bearer <HTTP access token>`.
 */
export class BitbucketClient {
  readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private lastAuthenticatedUser: string | undefined;

  constructor(private readonly options: ClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  // ---------------------------------------------------------------- low level

  private async request<T>(method: string, path: string, body?: unknown, accept = 'application/json'): Promise<T> {
    const token = await this.options.getToken();
    if (!token) {
      throw new BitbucketError('Not signed in', 401, 'auth');
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: accept,
      'X-Atlassian-Token': 'no-check',
    };
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, init);
    } catch (e) {
      throw new BitbucketError(`Network error calling ${this.baseUrl}: ${(e as Error).message}`, 0, 'network');
    }
    // Bitbucket echoes the authenticated user in this header on REST responses.
    const authenticatedUser = res.headers.get('x-ausername');
    if (authenticatedUser) {
      this.lastAuthenticatedUser = authenticatedUser;
    }
    if (!res.ok) {
      throw await this.toError(res, method, path);
    }
    if (res.status === 204) {
      return undefined as T;
    }
    if (accept === 'application/json') {
      const text = await res.text();
      return (text ? JSON.parse(text) : undefined) as T;
    }
    return (await res.text()) as unknown as T;
  }

  private async toError(res: Response, method: string, path: string): Promise<BitbucketError> {
    let serverMessage: string | undefined;
    try {
      const text = await res.text();
      if (text) {
        try {
          const parsed = JSON.parse(text) as ServerErrorBody;
          serverMessage = parsed.errors?.map((e) => e.message).filter(Boolean).join('; ') || undefined;
        } catch {
          serverMessage = text.length > 300 ? `${text.slice(0, 300)}…` : text;
        }
      }
    } catch {
      // ignore
    }
    const kind =
      res.status === 401
        ? 'auth'
        : res.status === 403
          ? 'forbidden'
          : res.status === 404
            ? 'notFound'
            : res.status === 409
              ? 'conflict'
              : res.status === 400
                ? 'badRequest'
                : res.status >= 500
                  ? 'server'
                  : 'other';
    const base =
      kind === 'auth'
        ? 'Authentication failed (invalid or expired token)'
        : kind === 'forbidden'
          ? 'Permission denied'
          : kind === 'notFound'
            ? 'Not found'
            : kind === 'conflict'
              ? 'Conflict (the item was modified on the server)'
              : `Request failed with HTTP ${res.status}`;
    const msg = serverMessage ? `${base}: ${serverMessage}` : `${base} (${method} ${path})`;
    return new BitbucketError(msg, res.status, kind, serverMessage);
  }

  private get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  /** Iterates all pages of a paged endpoint. `path` must not already contain `start`. */
  async getAllPages<T>(path: string, limit = 100, maxItems = 5000): Promise<T[]> {
    const out: T[] = [];
    let start = 0;
    const sep = path.includes('?') ? '&' : '?';
    for (;;) {
      const page = await this.get<Page<T>>(`${path}${sep}start=${start}&limit=${limit}`);
      out.push(...(page.values ?? []));
      if (page.isLastPage || page.nextPageStart === undefined || out.length >= maxItems) {
        break;
      }
      start = page.nextPageStart;
    }
    return out;
  }

  // ---------------------------------------------------------------- paths

  private repoPath({ projectKey, repoSlug }: RepoCoords): string {
    return `/rest/api/latest/projects/${encodeURIComponent(projectKey)}/repos/${encodeURIComponent(repoSlug)}`;
  }

  private prPath(repo: RepoCoords, prId: number): string {
    return `${this.repoPath(repo)}/pull-requests/${prId}`;
  }

  // ---------------------------------------------------------------- identity

  /**
   * Returns the user name of the authenticated user, or undefined when it cannot be determined.
   * Bitbucket has no "current user" endpoint; the `X-AUSERNAME` response header is used, with the
   * author of the user's own pull requests as a fallback.
   */
  async whoAmI(): Promise<string | undefined> {
    if (this.lastAuthenticatedUser) {
      return this.lastAuthenticatedUser;
    }
    try {
      await this.get('/rest/api/latest/inbox/pull-requests/count');
      if (this.lastAuthenticatedUser) {
        return this.lastAuthenticatedUser;
      }
      const page = await this.get<Page<PullRequest>>('/rest/api/latest/dashboard/pull-requests?role=AUTHOR&limit=1');
      return page.values?.[0]?.author?.user?.slug;
    } catch {
      return undefined;
    }
  }

  getUser(slug: string): Promise<BbUser> {
    return this.get<BbUser>(`/rest/api/latest/users/${encodeURIComponent(slug)}`);
  }

  /** Cheap authenticated call used to validate a token. */
  async validateToken(): Promise<void> {
    await this.get('/rest/api/latest/inbox/pull-requests/count');
  }

  // ---------------------------------------------------------------- pull requests

  /** Open outgoing pull requests whose source branch is `branch` (short name, without refs/heads/). */
  async findOpenPullRequestsForBranch(repo: RepoCoords, branch: string): Promise<PullRequest[]> {
    const q = toQuery({
      at: `refs/heads/${branch}`,
      direction: 'OUTGOING',
      state: 'OPEN',
      limit: 25,
    });
    const page = await this.get<Page<PullRequest>>(`${this.repoPath(repo)}/pull-requests${q}`);
    return page.values ?? [];
  }

  getPullRequest(repo: RepoCoords, prId: number): Promise<PullRequest> {
    return this.get<PullRequest>(this.prPath(repo, prId));
  }

  getChanges(repo: RepoCoords, prId: number): Promise<Change[]> {
    return this.getAllPages<Change>(`${this.prPath(repo, prId)}/changes`, 200);
  }

  /** Diff of one file in the PR (effective diff), including inline comments. */
  getFileDiff(
    repo: RepoCoords,
    prId: number,
    path: string,
    options: { srcPath?: string; contextLines?: number; withComments?: boolean } = {},
  ): Promise<DiffResponse> {
    const q = toQuery({
      srcPath: options.srcPath,
      contextLines: options.contextLines ?? 10,
      withComments: options.withComments ?? true,
      diffType: 'EFFECTIVE',
    });
    return this.get<DiffResponse>(`${this.prPath(repo, prId)}/diff/${encodePath(path)}${q}`);
  }

  // ---------------------------------------------------------------- comments

  /**
   * General (non-inline) comments of a PR. Newer DC versions return them when `path` is omitted;
   * as a fallback the activity stream is used.
   */
  async getGeneralComments(repo: RepoCoords, prId: number): Promise<Comment[]> {
    try {
      const comments = await this.getAllPages<Comment>(`${this.prPath(repo, prId)}/comments`, 100);
      return comments.filter((c) => !c.anchor);
    } catch (e) {
      if (e instanceof BitbucketError && (e.kind === 'badRequest' || e.kind === 'notFound')) {
        return this.getGeneralCommentsFromActivities(repo, prId);
      }
      throw e;
    }
  }

  /**
   * Activities carry a snapshot of each comment as it was when the activity happened, so after
   * collecting the root general comment ids we fetch the current version of each (with replies).
   */
  private async getGeneralCommentsFromActivities(repo: RepoCoords, prId: number): Promise<Comment[]> {
    const activities = await this.getActivities(repo, prId);
    const rootIds = new Set<number>();
    const deleted = new Set<number>();
    for (const a of activities) {
      if (a.action !== 'COMMENTED' || !a.comment || a.commentAnchor) {
        continue;
      }
      if (a.commentAction === 'DELETED') {
        deleted.add(a.comment.id);
      } else if (a.commentAction === 'ADDED' && !a.comment.parent) {
        rootIds.add(a.comment.id);
      }
    }
    const ids = [...rootIds].filter((id) => !deleted.has(id));
    const results: Comment[] = [];
    const queue = [...ids];
    const worker = async () => {
      while (queue.length) {
        const id = queue.shift()!;
        try {
          results.push(await this.getComment(repo, prId, id));
        } catch (e) {
          if (!(e instanceof BitbucketError && e.kind === 'notFound')) {
            throw e;
          }
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));
    return results.filter((c) => !c.anchor).sort((a, b) => a.createdDate - b.createdDate);
  }

  getActivities(repo: RepoCoords, prId: number): Promise<Activity[]> {
    return this.getAllPages<Activity>(`${this.prPath(repo, prId)}/activities`, 100);
  }

  getComment(repo: RepoCoords, prId: number, commentId: number): Promise<Comment> {
    return this.get<Comment>(`${this.prPath(repo, prId)}/comments/${commentId}`);
  }

  createComment(repo: RepoCoords, prId: number, body: CreateCommentRequest): Promise<Comment> {
    return this.request<Comment>('POST', `${this.prPath(repo, prId)}/comments`, body);
  }

  updateComment(repo: RepoCoords, prId: number, commentId: number, body: UpdateCommentRequest): Promise<Comment> {
    return this.request<Comment>('PUT', `${this.prPath(repo, prId)}/comments/${commentId}`, body);
  }

  deleteComment(repo: RepoCoords, prId: number, commentId: number, version: number): Promise<void> {
    return this.request<void>('DELETE', `${this.prPath(repo, prId)}/comments/${commentId}?version=${version}`);
  }

  // ---------------------------------------------------------------- files

  /** Raw file content at a commit. Returns undefined when the file does not exist at that commit. */
  async getRawFile(repo: RepoCoords, path: string, at: string): Promise<string | undefined> {
    try {
      return await this.request<string>('GET', `${this.repoPath(repo)}/raw/${encodePath(path)}?at=${encodeURIComponent(at)}`, undefined, '*/*');
    } catch (e) {
      if (e instanceof BitbucketError && e.kind === 'notFound') {
        return undefined;
      }
      throw e;
    }
  }

  // ---------------------------------------------------------------- links

  pullRequestUrl(repo: RepoCoords, prId: number): string {
    return `${this.baseUrl}/projects/${encodeURIComponent(repo.projectKey)}/repos/${encodeURIComponent(repo.repoSlug)}/pull-requests/${prId}/overview`;
  }

  commentUrl(repo: RepoCoords, prId: number, commentId: number, path?: string): string {
    const base = `${this.baseUrl}/projects/${encodeURIComponent(repo.projectKey)}/repos/${encodeURIComponent(repo.repoSlug)}/pull-requests/${prId}`;
    if (path) {
      return `${base}/diff#${encodePath(path)}?commentId=${commentId}`;
    }
    return `${base}/overview?commentId=${commentId}`;
  }
}
