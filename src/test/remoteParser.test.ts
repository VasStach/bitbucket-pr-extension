import * as assert from 'node:assert';
import { parseBitbucketRemote } from '../core/remoteParser';

describe('remoteParser.parseBitbucketRemote', () => {
  it('parses HTTPS scm clone URLs', () => {
    assert.deepStrictEqual(parseBitbucketRemote('https://git.tipsport.it/scm/ml-services/esports.git'), {
      host: 'git.tipsport.it',
      baseUrl: 'https://git.tipsport.it',
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
    const r = parseBitbucketRemote('https://git.tipsport.it/scm/~vaclav.stach/sandbox.git');
    assert.strictEqual(r?.projectKey, '~VACLAV.STACH');
    assert.strictEqual(r?.repoSlug, 'sandbox');
  });

  it('parses ssh:// URLs and uses the fallback base URL for a matching host', () => {
    assert.deepStrictEqual(parseBitbucketRemote('ssh://git@git.tipsport.it:7999/ml-services/esports.git', 'https://git.tipsport.it'), {
      host: 'git.tipsport.it',
      baseUrl: 'https://git.tipsport.it',
      projectKey: 'ML-SERVICES',
      repoSlug: 'esports',
    });
  });

  it('parses scp-like URLs', () => {
    assert.deepStrictEqual(parseBitbucketRemote('git@git.tipsport.it:ML-SERVICES/esports.git'), {
      host: 'git.tipsport.it',
      baseUrl: 'https://git.tipsport.it',
      projectKey: 'ML-SERVICES',
      repoSlug: 'esports',
    });
  });

  it('parses web browse URLs', () => {
    assert.deepStrictEqual(parseBitbucketRemote('https://git.tipsport.it/projects/ML-SERVICES/repos/esports/browse'), {
      host: 'git.tipsport.it',
      baseUrl: 'https://git.tipsport.it',
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
