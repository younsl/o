import { createApiRef } from '@backstage/core-plugin-api';
import { ApplicationSetResponse, PluginStatus } from './types';

export interface ArgocdAppsetApi {
  listApplicationSets(): Promise<ApplicationSetResponse[]>;
  getStatus(): Promise<PluginStatus>;
  mute(namespace: string, name: string): Promise<void>;
  unmute(namespace: string, name: string): Promise<void>;
}

export const argocdAppsetApiRef = createApiRef<ArgocdAppsetApi>({
  id: 'plugin.argocd-appset.api',
});
