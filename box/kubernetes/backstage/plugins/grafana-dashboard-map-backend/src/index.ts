/**
 * Grafana Dashboard Map Backend Plugin
 *
 * Fetches dashboards from Grafana via HTTP API and persists a shared
 * architecture-component layout. Admins can save the layout; everyone can
 * read it.
 */

export { grafanaDashboardMapPlugin as default } from './plugin';
export * from './service/types';
