/**
 * Grafana Dashboard Map Frontend Plugin
 *
 * A landing page that lays Grafana dashboards out on a standard architecture
 * diagram. Admins can drag dashboards between components, classify them by
 * tier (L1/L2/L3), and save the layout. Other users get a read-only view.
 */

export { grafanaDashboardMapPlugin, GrafanaDashboardMapPage } from './plugin';
export { grafanaDashboardMapApiRef } from './api';
export * from './api/types';
