import { GitlabToken } from './types';

export class TokenCache {
  private tokens: GitlabToken[] = [];
  private lastFetchedAt: string | null = null;

  update(tokens: GitlabToken[]) {
    this.tokens = tokens;
    this.lastFetchedAt = new Date().toISOString();
  }

  getTokens(): GitlabToken[] {
    return this.tokens;
  }

  getLastFetchedAt(): string | null {
    return this.lastFetchedAt;
  }
}
