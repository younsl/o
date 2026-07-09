import React from 'react';
import { Link } from 'react-router-dom';
import { configApiRef, useApi, useRouteRef } from '@backstage/core-plugin-api';
import { Flex } from '@backstage/ui';
import {
  rootRouteRef,
  createAccountRouteRef,
  approvalsRouteRef,
} from '../routes';
import './opensearch-account.css';

export type NavKey = 'accounts' | 'create' | 'approvals' | 'conflicts';

/**
 * Top navigation for the OpenSearch pages. Accounts is admin-only;
 * regular users can create accounts, inspect their requests, and view field conflicts.
 */
export const OpenSearchNav = ({
  current,
  isAdmin,
}: {
  current: NavKey;
  isAdmin: boolean;
}) => {
  const config = useApi(configApiRef);
  const accountsLink = useRouteRef(rootRouteRef);
  const createLink = useRouteRef(createAccountRouteRef);
  const approvalsLink = useRouteRef(approvalsRouteRef);
  const conflictsEnabled =
    config.getOptionalBoolean('app.plugins.opensearchViewer') ?? true;

  const cls = (key: NavKey) => `osa-tab ${current === key ? 'osa-tab-active' : ''}`;

  return (
    <Flex gap="1" align="center" className="osa-nav">
      {isAdmin && (
        <Link className={cls('accounts')} to={accountsLink()}>
          Accounts
        </Link>
      )}
      <Link className={cls('create')} to={createLink()}>
        Create User
      </Link>
      <Link className={cls('approvals')} to={approvalsLink()}>
        Requests
      </Link>
      {conflictsEnabled && (
        <Link className={cls('conflicts')} to="/opensearch/conflicts">
          Field Conflicts
        </Link>
      )}
    </Flex>
  );
};
