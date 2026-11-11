import * as assert from 'node:assert';
import { parseBitbucketRemote } from '../core/remoteParser';

describe('remoteParser.parseBitbucketRemote', () => {
  it('parses HTTPS scm clone URLs', () => {
    assert.deepStrictEqual(parseBitbucketRemote('https://bitbucket.example.com/scm/ml-services/esports.git'), {
      host: 'bitbucket.example.com',
      baseUrl: 'https://bitbucket.example.com',
      projectKey: 'ML-SERVICES',
      repoSlug: 'esports',
    });
  });

  it('parses HTTPS URLs with a user, port and context path', () => {
    assert.deepStrictEqual(parseBitbucketRemote('https://john@bb.example.com:8443/bitbucket/scm/PROJ/My-Repo.git'), {
      host: 'bb.example.com:8443',
      baseUrl: 'https://bb.example.com:8443/bitbucket',
      projectKey: 'PROJ',
      repoSlug: 'my-repo',
    });
  });

  it('parses personal repositories', () => {
    const r = parseBitbucketRemote('https://bitbucket.example.com/scm/~alice/sandbox.git');
    assert.strictEqual(r?.projectKey, '~ALICE');
    assert.strictEqual(r?.repoSlug, 'sandbox');
  });

  it('parses ssh:// URLs and uses the fallback base URL for a matching host', () => {
    assert.deepStrictEqual(parseBitbucketRemote('ssh://git@bitbucket.example.com:7999/ml-services/esports.git', 'https://bitbucket.example.com'), {
      host: 'bitbucket.example.com',
      baseUrl: 'https://bitbucket.example.com',
      projectKey: 'ML-SERVICES',
      repoSlug: 'esports',
    });
  });

  it('parses scp-like URLs', () => {
    assert.deepStrictEqual(parseBitbucketRemote('git@bitbucket.example.com:ML-SERVICES/esports.git'), {
      host: 'bitbucket.example.com',
      baseUrl: 'https://bitbucket.example.com',
      projectKey: 'ML-SERVICES',
      repoSlug: 'esports',
    });
  });

  it('parses web browse URLs', () => {
    assert.deepStrictEqual(parseBitbucketRemote('https://bitbucket.example.com/projects/ML-SERVICES/repos/esports/browse'), {
      host: 'bitbucket.example.com',
      baseUrl: 'https://bitbucket.example.com',
      projectKey: 'ML-SERVICES',
      repoSlug: 'esports',
    });
  });

  it('ignores non-Bitbucket remotes', () => {
    assert.strictEqual(parseBitbucketRemote('https://github.com/owner/repo.git'), undefined);
    assert.strictEqual(parseBitbucketRemote('git@github.com:owner/repo.git'), undefined);
    assert.strictEqual(parseBitbucketRemote('ssh://git@gitlab.com/group/repo.git'), undefined);
    assert.strictEqual(parseBitbucketRemote(''), undefined);
    assert.strictEqual(parseBitbucketRemote('not a url'), undefined);
  });
});
