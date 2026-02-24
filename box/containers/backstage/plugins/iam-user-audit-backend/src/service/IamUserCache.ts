import { IamUserResponse } from './types';

export class IamUserCache {
  private cachedUsers: IamUserResponse[] = [];
  private lastFetchedAt: string | null = null;

  update(users: IamUserResponse[]) {
    this.cachedUsers = users;
    this.lastFetchedAt = new Date().toISOString();
  }

  getUsers(): IamUserResponse[] {
    return this.cachedUsers;
  }

  getLastFetchedAt(): string | null {
    return this.lastFetchedAt;
  }
}
