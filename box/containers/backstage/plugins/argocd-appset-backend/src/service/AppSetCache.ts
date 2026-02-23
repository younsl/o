import { ApplicationSetResponse } from './types';

export class AppSetCache {
  private cachedAppSets: ApplicationSetResponse[] = [];
  private lastFetchedAt: string | null = null;

  update(appSets: ApplicationSetResponse[]) {
    this.cachedAppSets = appSets;
    this.lastFetchedAt = new Date().toISOString();
  }

  getAppSets(): ApplicationSetResponse[] {
    return this.cachedAppSets;
  }

  getLastFetchedAt(): string | null {
    return this.lastFetchedAt;
  }
}
