/**
 * OpenSearch Account Frontend Plugin
 *
 * Self-service request workflow for OpenSearch Security internal users:
 * list existing accounts, request account creation (with backend/security
 * role mapping), and request account deletion. Create/delete requests go
 * through an admin approval step; on approval the backend calls the
 * OpenSearch Security API and returns a one-time generated password.
 */
export {
  opensearchAccountPlugin,
  OpenSearchAccountPage,
  OpenSearchAccountCreatePage,
  OpenSearchAccountApprovalsPage,
} from './plugin';
export { OpenSearchNav } from './components/OpenSearchNav';
export { opensearchAccountApiRef } from './api';
export * from './api/types';
