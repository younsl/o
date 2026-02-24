import React, { PropsWithChildren, useEffect, useState } from 'react';
import { makeStyles, Typography, Collapse } from '@material-ui/core';
import CategoryIcon from '@material-ui/icons/Category';
import ExtensionIcon from '@material-ui/icons/Extension';
import LibraryBooks from '@material-ui/icons/LibraryBooks';
import CreateComponentIcon from '@material-ui/icons/AddCircleOutline';
import SearchIcon from '@material-ui/icons/Search';
import GroupIcon from '@material-ui/icons/Group';
import HomeIcon from '@material-ui/icons/Home';
import DashboardIcon from '@material-ui/icons/Dashboard';
import CloudUploadIcon from '@material-ui/icons/CloudUpload';
import ExpandMoreIcon from '@material-ui/icons/ExpandMore';
import ExpandLessIcon from '@material-ui/icons/ExpandLess';
import AppsIcon from '@material-ui/icons/Apps';
import SecurityIcon from '@material-ui/icons/Security';
import { siArgo, siKubernetes } from 'simple-icons';
import { createIcon } from '@dweber019/backstage-plugin-simple-icons';

const ArgocdIcon = createIcon(siArgo, false);
const KubernetesIcon = createIcon(siKubernetes, false);
import {
  Settings as SidebarSettings,
  UserSettingsSignInAvatar,
} from '@backstage/plugin-user-settings';
import { SidebarSearchModal } from '@backstage/plugin-search';
import {
  Sidebar,
  sidebarConfig,
  SidebarDivider,
  SidebarGroup,
  SidebarItem,
  SidebarPage,
  SidebarScrollWrapper,
  SidebarSpace,
  useSidebarOpenState,
  Link,
} from '@backstage/core-components';
import { MyGroupsSidebarItem } from '@backstage/plugin-org';
import {
  configApiRef,
  discoveryApiRef,
  fetchApiRef,
  identityApiRef,
  useApi,
} from '@backstage/core-plugin-api';
import LogoFull from './LogoFull';
import LogoIcon from './LogoIcon';
import './Root.css';

const useSidebarLogoStyles = makeStyles({
  root: {
    height: 3 * sidebarConfig.logoHeight,
    display: 'flex',
    flexFlow: 'row nowrap',
    alignItems: 'center',
    marginBottom: -14,
  },
  link: {
    marginLeft: 24,
  },
});

const SidebarLogo = () => {
  const classes = useSidebarLogoStyles();
  const { isOpen } = useSidebarOpenState();

  return (
    <div className={classes.root}>
      <Link to="/" underline="none" className={classes.link} aria-label="Home">
        {isOpen ? <LogoFull /> : <LogoIcon />}
      </Link>
    </div>
  );
};

const useUserStyles = makeStyles({
  userInfo: {
    padding: '8px 24px',
    display: 'flex',
    alignItems: 'center',
  },
  userName: {
    fontSize: '0.875rem',
    color: 'rgba(255, 255, 255, 0.7)',
  },
});

const CurrentUser = () => {
  const classes = useUserStyles();
  const { isOpen } = useSidebarOpenState();
  const identityApi = useApi(identityApiRef);
  const [displayName, setDisplayName] = useState<string>('');

  useEffect(() => {
    identityApi.getProfileInfo().then(profile => {
      setDisplayName(profile.displayName || 'Guest');
    });
  }, [identityApi]);

  if (!isOpen) return null;

  return (
    <div className={classes.userInfo}>
      <Typography className={classes.userName}>
        Logged in as: {displayName}
      </Typography>
    </div>
  );
};

const useFoldableSectionStyles = makeStyles({
  header: {
    display: 'flex',
    alignItems: 'center',
    width: '100%',
    height: 48,
    paddingLeft: 24,
    paddingRight: 20,
    boxSizing: 'border-box',
    cursor: 'pointer',
    '&:hover': {
      backgroundColor: 'rgba(255, 255, 255, 0.08)',
    },
  },
  headerCollapsed: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
    height: 48,
    boxSizing: 'border-box',
    cursor: 'pointer',
    '&:hover': {
      backgroundColor: 'rgba(255, 255, 255, 0.08)',
    },
  },
  icon: {
    color: 'rgba(255, 255, 255, 0.7)',
    marginRight: 16,
    fontSize: 20,
  },
  iconCollapsed: {
    color: 'rgba(255, 255, 255, 0.7)',
    fontSize: 20,
  },
  title: {
    flex: 1,
    fontSize: '0.75rem',
    fontWeight: 700,
    textTransform: 'uppercase',
    color: 'rgba(255, 255, 255, 0.5)',
    letterSpacing: '0.5px',
  },
  expandIcon: {
    color: 'rgba(255, 255, 255, 0.5)',
    fontSize: 18,
  },
});

interface FoldableSectionProps {
  title: string;
  icon: React.ReactElement;
  defaultOpen?: boolean;
  children: React.ReactNode;
}

const FoldableSection = ({
  title,
  icon,
  defaultOpen = true,
  children,
}: FoldableSectionProps) => {
  const classes = useFoldableSectionStyles();
  const { isOpen: sidebarOpen } = useSidebarOpenState();
  const [expanded, setExpanded] = useState(defaultOpen);

  const handleToggle = () => {
    setExpanded(!expanded);
  };

  if (!sidebarOpen) {
    return (
      <div
        className={classes.headerCollapsed}
        onClick={handleToggle}
        role="button"
        tabIndex={0}
        onKeyDown={e => e.key === 'Enter' && handleToggle()}
      >
        {React.cloneElement(icon, { className: classes.iconCollapsed })}
      </div>
    );
  }

  return (
    <>
      <div
        className={classes.header}
        onClick={handleToggle}
        role="button"
        tabIndex={0}
        onKeyDown={e => e.key === 'Enter' && handleToggle()}
      >
        {React.cloneElement(icon, { className: classes.icon })}
        <Typography className={classes.title}>{title}</Typography>
        {expanded ? (
          <ExpandLessIcon className={classes.expandIcon} />
        ) : (
          <ExpandMoreIcon className={classes.expandIcon} />
        )}
      </div>
      <Collapse in={expanded}>{children}</Collapse>
    </>
  );
};

const IamAuditSidebarItem = () => {
  const discoveryApi = useApi(discoveryApiRef);
  const fetchApi = useApi(fetchApiRef);
  const [pendingCount, setPendingCount] = useState(0);

  useEffect(() => {
    const fetchPending = async () => {
      try {
        const baseUrl = await discoveryApi.getBaseUrl('iam-user-audit');
        const response = await fetchApi.fetch(
          `${baseUrl}/password-reset/requests`,
        );
        const data = await response.json();
        setPendingCount(
          data.filter((r: any) => r.status === 'pending').length,
        );
      } catch {
        /* ignore */
      }
    };
    fetchPending();
    const interval = setInterval(fetchPending, 60_000);
    return () => clearInterval(interval);
  }, [discoveryApi, fetchApi]);

  return (
    <SidebarItem icon={SecurityIcon} to="iam-user-audit" text="IAM Audit">
      <span
        className={
          pendingCount > 0 ? 'sidebar-badge' : 'sidebar-badge sidebar-badge-zero'
        }
      >
        {pendingCount}
      </span>
    </SidebarItem>
  );
};

export const Root = ({ children }: PropsWithChildren<{}>) => {
  const config = useApi(configApiRef);
  const argocdAppSetEnabled = config.getOptionalBoolean('argocdApplicationSet.enabled') ?? true;
  const iamUserAuditEnabled = config.getOptionalBoolean('iamUserAudit.enabled') ?? true;

  return (
  <SidebarPage>
    <Sidebar>
      <SidebarLogo />
      <SidebarGroup label="Search" icon={<SearchIcon />} to="/search">
        <SidebarSearchModal />
      </SidebarGroup>
      <SidebarDivider />
      <SidebarItem icon={HomeIcon} to="/" text="Home" />
      <SidebarItem icon={KubernetesIcon} to="platforms" text="Platforms" />
      <SidebarDivider />

      {/* Resources Section */}
      <FoldableSection title="Resources" icon={<AppsIcon />} defaultOpen={false}>
        <SidebarItem icon={CategoryIcon} to="catalog" text="Catalog" />
        <SidebarItem icon={ExtensionIcon} to="api-docs" text="APIs" />
        <SidebarItem icon={CloudUploadIcon} to="openapi-registry" text="API Registry" />
        <SidebarItem icon={LibraryBooks} to="docs" text="Docs" />
      </FoldableSection>

      {/* Operations Section */}
      {(argocdAppSetEnabled || iamUserAuditEnabled) && (
        <FoldableSection title="Operations" icon={<DashboardIcon />} defaultOpen={false}>
          {argocdAppSetEnabled && (
            <SidebarItem icon={ArgocdIcon} to="argocd-appset" text="ArgoCD" />
          )}
          {iamUserAuditEnabled && <IamAuditSidebarItem />}
        </FoldableSection>
      )}

      <SidebarDivider />
      <SidebarItem icon={CreateComponentIcon} to="create" text="Create..." />
      <SidebarDivider />
      <SidebarScrollWrapper>
        <MyGroupsSidebarItem
          singularTitle="My Group"
          pluralTitle="My Groups"
          icon={GroupIcon}
        />
      </SidebarScrollWrapper>

      <SidebarSpace />
      <SidebarDivider />
      <CurrentUser />
      <SidebarGroup
        label="Settings"
        icon={<UserSettingsSignInAvatar />}
        to="/settings"
      >
        <SidebarSettings />
      </SidebarGroup>
    </Sidebar>
    {children}
  </SidebarPage>
  );
};
