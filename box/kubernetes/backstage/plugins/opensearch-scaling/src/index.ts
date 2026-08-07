/**
 * OpenSearch Scaling Frontend Plugin
 *
 * Self-service workflow for DevOps engineers to reserve Amazon OpenSearch
 * Service domain scaling (data-node instance type, node count, and per-node
 * EBS volume size) for execution at a chosen future time. Submitting validates
 * up front that the domain has no change/upgrade already in progress; a backend
 * scheduler applies the change at the reserved instant (re-validating first).
 */
export {
  opensearchScalingPlugin,
  OpenSearchScalingPage,
  OpenSearchScalingCreatePage,
} from './plugin';
export { opensearchScalingApiRef } from './api';
export * from './api/types';
