import * as assert from 'node:assert';
import { BitbucketClient, BitbucketError, encodePath, type FetchLike } from '../bitbucket/client';

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function mockFetch(handler: (req: Recorded) => { status: number; body?: unknown; text?: string }): { fetch: FetchLike; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const fetch: FetchLike = async (url, init) => {
    const rec: Recorded = {
      url,
      method: init?.method ?? 'GET',
      headers: (init?.headers as Record<string, string>) ?? {},
      body: typeof init?.body === 'string' ? init.body : undefined,
    };
    calls.push(rec);
    const r = handler(rec);
    const text = r.text ?? (r.body !== undefined ? JSON.stringify(r.body) : '');
    if (r.status === 204) {
      return new Response(null, { status: 204 });
    }
    return new Response(text, { status: r.status, headers: { 'content-type': 'application/json' } });
  };
  return { fetch, calls };
}

const repo = { projectKey: 'PROJ', repoSlug: 'repo' };

describe('BitbucketClient', () => {
  it('sends a Bearer token and JSON accept header', async () => {
    const m = mockFetch(() => ({ status: 200, body: { id: 1, version: 0 } }));
    const client = new BitbucketClient({ baseUrl: 'https://bb.example.com/', getToken: async () => 'secret-token', fetchImpl: m.fetch });
    await client.getPullRequest(repo, 1);
    assert.strictEqual(m.calls.length, 1);
    assert.strictEqual(m.calls[0].url, 'https://bb.example.com/rest/api/latest/projects/PROJ/repos/repo/pull-requests/1');
    assert.strictEqual(m.calls[0].headers.Authorization, 'Bearer secret-token');
    assert.strictEqual(m.calls[0].headers.Accept, 'application/json');
  });

  it('fails with an auth error when no token is stored, without calling the server', async () => {
    const m = mockFetch(() => ({ status: 200, body: {} }));
    const client = new BitbucketClient({ baseUrl: 'https://bb.example.com', getToken: async () => undefined, fetchImpl: m.fetch });
    await assert.rejects(client.getPullRequest(repo, 1), (e: unknown) => e instanceof BitbucketError && e.kind === 'auth');
    assert.strictEqual(m.calls.length, 0);
  });

  it('follows pagination using nextPageStart', async () => {
    const m = mockFetch((req) => {
      const start = Number(new URL(req.url).searchParams.get('start'));
      if (start === 0) {
        return { status: 200, body: { size: 2, limit: 2, isLastPage: false, start: 0, nextPageStart: 2, values: [{ id: 1 }, { id: 2 }] } };
      }
      return { status: 200, body: { size: 1, limit: 2, isLastPage: true, start: 2, values: [{ id: 3 }] } };
    });
    const client = new BitbucketClient({ baseUrl: 'https://bb.example.com', getToken: async () => 't', fetchImpl: m.fetch });
    const all = await client.getAllPages<{ id: number }>('/x?foo=bar', 2);
    assert.deepStrictEqual(
      all.map((v) => v.id),
      [1, 2, 3],
    );
    assert.strictEqual(m.calls[0].url, 'https://bb.example.com/x?foo=bar&start=0&limit=2');
    assert.strictEqual(m.calls[1].url, 'https://bb.example.com/x?foo=bar&start=2&limit=2');
  });

  it('maps HTTP status codes to error kinds and extracts server messages', async () => {
    const statuses: [number, BitbucketError['kind']][] = [
      [401, 'auth'],
      [403, 'forbidden'],
      [404, 'notFound'],
      [409, 'conflict'],
      [400, 'badRequest'],
      [500, 'server'],
    ];
    for (const [status, kind] of statuses) {
      const m = mockFetch(() => ({ status, body: { errors: [{ message: `boom ${status}` }] } }));
      const client = new BitbucketClient({ baseUrl: 'https://bb.example.com', getToken: async () => 't', fetchImpl: m.fetch });
      await assert.rejects(client.getPullRequest(repo, 1), (e: unknown) => {
        assert.ok(e instanceof BitbucketError);
        assert.strictEqual(e.kind, kind);
        assert.strictEqual(e.status, status);
        assert.ok(e.message.includes(`boom ${status}`));
        assert.strictEqual(e.isPermissionProblem, kind === 'auth' || kind === 'forbidden');
        return true;
      });
    }
  });

  it('creates inline comments with the anchor payload', async () => {
    const m = mockFetch(() => ({ status: 201, body: { id: 42, version: 0, text: 'hi' } }));
    const client = new BitbucketClient({ baseUrl: 'https://bb.example.com', getToken: async () => 't', fetchImpl: m.fetch });
    const created = await client.createComment(repo, 7, {
      text: 'hi',
      severity: 'NORMAL',
      anchor: { path: 'src/a b.ts', line: 3, lineType: 'ADDED', fileType: 'TO', diffType: 'EFFECTIVE' },
    });
    assert.strictEqual(created.id, 42);
    assert.strictEqual(m.calls[0].method, 'POST');
    assert.strictEqual(m.calls[0].headers['Content-Type'], 'application/json');
    assert.deepStrictEqual(JSON.parse(m.calls[0].body!), {
      text: 'hi',
      severity: 'NORMAL',
      anchor: { path: 'src/a b.ts', line: 3, lineType: 'ADDED', fileType: 'TO', diffType: 'EFFECTIVE' },
    });
  });

  it('deletes with the version query parameter and tolerates empty bodies', async () => {
    const m = mockFetch(() => ({ status: 204, text: '' }));
    const client = new BitbucketClient({ baseUrl: 'https://bb.example.com', getToken: async () => 't', fetchImpl: m.fetch });
    await client.deleteComment(repo, 7, 42, 3);
    assert.strictEqual(m.calls[0].method, 'DELETE');
    assert.ok(m.calls[0].url.endsWith('/pull-requests/7/comments/42?version=3'));
  });

  it('falls back to activities for general comments when /comments rejects the request', async () => {
    const m = mockFetch((req) => {
      if (req.url.includes('/comments?')) {
        return { status: 400, body: { errors: [{ message: 'path is required' }] } };
      }
      const single = /\/comments\/(\d+)$/.exec(req.url);
      if (single) {
        const id = Number(single[1]);
        if (id === 12) {
          return { status: 404, body: { errors: [{ message: 'gone' }] } };
        }
        // Current version (edited text, with replies) differs from the activity snapshot.
        return { status: 200, body: { id, version: 2, text: `current ${id}`, createdDate: id, comments: [{ id: 100 + id, version: 0, text: 'reply', createdDate: id + 50, comments: [] }] } };
      }
      return {
        status: 200,
        body: {
          isLastPage: true,
          values: [
            { id: 1, action: 'COMMENTED', commentAction: 'ADDED', comment: { id: 10, version: 0, text: 'general', createdDate: 2, comments: [] } },
            { id: 2, action: 'COMMENTED', commentAction: 'ADDED', commentAnchor: { path: 'a' }, comment: { id: 11, version: 0, text: 'inline', createdDate: 3, comments: [] } },
            { id: 3, action: 'COMMENTED', commentAction: 'ADDED', comment: { id: 9, version: 0, text: 'older', createdDate: 1, comments: [] } },
            { id: 4, action: 'COMMENTED', commentAction: 'REPLIED', comment: { id: 109, version: 0, text: 'reply', parent: { id: 9 }, createdDate: 59, comments: [] } },
            { id: 5, action: 'COMMENTED', commentAction: 'ADDED', comment: { id: 12, version: 0, text: 'later deleted', createdDate: 12, comments: [] } },
            { id: 6, action: 'COMMENTED', commentAction: 'DELETED', comment: { id: 12, version: 0, text: 'later deleted', createdDate: 12, comments: [] } },
          ],
        },
      };
    });
    const client = new BitbucketClient({ baseUrl: 'https://bb.example.com', getToken: async () => 't', fetchImpl: m.fetch });
    const comments = await client.getGeneralComments(repo, 7);
    assert.deepStrictEqual(
      comments.map((c) => c.id),
      [9, 10],
    );
    assert.strictEqual(comments[0].text, 'current 9');
    assert.strictEqual(comments[0].comments.length, 1);
    assert.ok(!m.calls.some((c) => c.url.endsWith('/comments/12')), 'deleted comments are not fetched');
  });

  it('encodes repository paths segment by segment', () => {
    assert.strictEqual(encodePath('src/a b/c#d.ts'), 'src/a%20b/c%23d.ts');
  });

  it('returns undefined for raw files that do not exist at the commit', async () => {
    const m = mockFetch(() => ({ status: 404, text: '' }));
    const client = new BitbucketClient({ baseUrl: 'https://bb.example.com', getToken: async () => 't', fetchImpl: m.fetch });
    assert.strictEqual(await client.getRawFile(repo, 'missing.txt', 'abc'), undefined);
  });
});
