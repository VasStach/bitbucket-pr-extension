import type { TokenStore } from '../auth/tokenStore';
import { hostOf } from '../core/remoteParser';
import { BitbucketClient } from './client';

/** One client per Bitbucket base URL; tokens are resolved lazily per request from the TokenStore. */
export class ClientRegistry {
  private readonly clients = new Map<string, BitbucketClient>();

  constructor(private readonly tokens: TokenStore) {}

  get(baseUrl: string): BitbucketClient {
    const key = baseUrl.replace(/\/+$/, '');
    let client = this.clients.get(key);
    if (!client) {
      const host = hostOf(key);
      client = new BitbucketClient({
        baseUrl: key,
        getToken: () => this.tokens.getToken(host),
      });
      this.clients.set(key, client);
    }
    return client;
  }
}
