/**
 * Parses Bitbucket Data Center clone URLs into host / project key / repository slug.
 *
 * Supported forms:
 *  - https://host[:port]/scm/PROJECT/repo.git            (HTTP clone)
 *  - https://host[:port]/scm/~user/repo.git              (personal repo)
 *  - https://host[:port]/context/scm/PROJECT/repo.git    (context path)
 *  - ssh://git@host[:port]/PROJECT/repo.git
 *  - git@host:PROJECT/repo.git  (scp-like)
 *  - https://host/projects/PROJECT/repos/repo[/browse]   (web URL)
 */
export interface ParsedRemote {
  /** host[:port], lowercase */
  host: string;
  /** Base URL used for REST calls, e.g. https://host or https://host/context */
  baseUrl: string;
  projectKey: string;
  repoSlug: string;
}

function stripGitSuffix(s: string): string {
  return s.replace(/\.git$/i, '').replace(/\/+$/, '');
}

/** Hosts that are certainly not Bitbucket Data Center (ssh/scp URLs carry no `scm` marker). */
const KNOWN_NON_BITBUCKET_HOSTS = new Set(['github.com', 'gitlab.com', 'bitbucket.org', 'altssh.bitbucket.org', 'dev.azure.com', 'ssh.dev.azure.com', 'vs-ssh.visualstudio.com', 'codeberg.org', 'sr.ht', 'git.sr.ht']);

function isKnownNonBitbucket(host: string): boolean {
  const bare = host.replace(/:\d+$/, '');
  return KNOWN_NON_BITBUCKET_HOSTS.has(bare) || bare.endsWith('.visualstudio.com');
}

export function parseBitbucketRemote(url: string, fallbackBaseUrl?: string): ParsedRemote | undefined {
  const trimmed = url.trim();
  if (!trimmed) {
    return undefined;
  }

  // scp-like: git@host:PROJECT/repo.git
  const scp = /^(?:[\w.-]+@)?([\w.-]+):(?!\/\/)([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(trimmed);
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    const host = scp[1].toLowerCase();
    if (isKnownNonBitbucket(host)) {
      return undefined;
    }
    return {
      host,
      baseUrl: baseUrlFor(host, fallbackBaseUrl),
      projectKey: normalizeProject(scp[2]),
      repoSlug: stripGitSuffix(scp[3]).toLowerCase(),
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return undefined;
  }

  const protocol = parsed.protocol.replace(':', '').toLowerCase();
  const hostWithPort = parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
  const segments = parsed.pathname.split('/').filter(Boolean);

  if (protocol === 'ssh') {
    // ssh://git@host[:port]/PROJECT/repo.git
    if (segments.length < 2) {
      return undefined;
    }
    const host = parsed.hostname.toLowerCase();
    if (isKnownNonBitbucket(host)) {
      return undefined;
    }
    return {
      host,
      baseUrl: baseUrlFor(host, fallbackBaseUrl),
      projectKey: normalizeProject(segments[segments.length - 2]),
      repoSlug: stripGitSuffix(segments[segments.length - 1]).toLowerCase(),
    };
  }

  if (protocol === 'http' || protocol === 'https') {
    const host = hostWithPort.toLowerCase();
    // /[context/]scm/PROJECT/repo.git
    const scmIdx = segments.indexOf('scm');
    if (scmIdx >= 0 && segments.length >= scmIdx + 3) {
      const context = segments.slice(0, scmIdx);
      return {
        host,
        baseUrl: `${protocol}://${host}${context.length ? '/' + context.join('/') : ''}`,
        projectKey: normalizeProject(segments[scmIdx + 1]),
        repoSlug: stripGitSuffix(segments[scmIdx + 2]).toLowerCase(),
      };
    }
    // /[context/]projects/PROJECT/repos/repo[/...]
    const projIdx = segments.indexOf('projects');
    if (projIdx >= 0 && segments[projIdx + 2] === 'repos' && segments.length >= projIdx + 4) {
      const context = segments.slice(0, projIdx);
      return {
        host,
        baseUrl: `${protocol}://${host}${context.length ? '/' + context.join('/') : ''}`,
        projectKey: normalizeProject(segments[projIdx + 1]),
        repoSlug: stripGitSuffix(segments[projIdx + 3]).toLowerCase(),
      };
    }
    // /[context/]users/USER/repos/repo
    const usersIdx = segments.indexOf('users');
    if (usersIdx >= 0 && segments[usersIdx + 2] === 'repos' && segments.length >= usersIdx + 4) {
      const context = segments.slice(0, usersIdx);
      return {
        host,
        baseUrl: `${protocol}://${host}${context.length ? '/' + context.join('/') : ''}`,
        projectKey: `~${segments[usersIdx + 1].toUpperCase()}`,
        repoSlug: stripGitSuffix(segments[usersIdx + 3]).toLowerCase(),
      };
    }
  }
  return undefined;
}

/** Project keys are upper-case in Bitbucket; personal projects keep the `~user` form. */
function normalizeProject(key: string): string {
  const k = decodeURIComponent(key);
  return k.startsWith('~') ? `~${k.substring(1).toUpperCase()}` : k.toUpperCase();
}

function baseUrlFor(host: string, fallbackBaseUrl?: string): string {
  if (fallbackBaseUrl) {
    try {
      const u = new URL(fallbackBaseUrl);
      const fbHost = (u.port ? `${u.hostname}:${u.port}` : u.hostname).toLowerCase();
      if (fbHost === host || u.hostname.toLowerCase() === host) {
        return fallbackBaseUrl.replace(/\/+$/, '');
      }
    } catch {
      // ignore invalid fallback
    }
  }
  return `https://${host}`;
}

/** Host part (without port) of a base URL. */
export function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return baseUrl.toLowerCase();
  }
}
