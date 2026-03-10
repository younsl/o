import React, { PropsWithChildren, useEffect, useState } from 'react';
import { makeStyles, Typography, Collapse } from '@material-ui/core';
import CategoryIcon from '@material-ui/icons/Category';
import ExtensionIcon from '@material-ui/icons/Extension';
import LibraryBooks from '@material-ui/icons/LibraryBooks';
import CreateComponentIcon from '@material-ui/icons/AddCircleOutline';
import SearchIcon from '@material-ui/icons/Search';
import GroupIcon from '@material-ui/icons/Group';
import BuildIcon from '@material-ui/icons/Build';
import CloudUploadIcon from '@material-ui/icons/CloudUpload';
import ExpandMoreIcon from '@material-ui/icons/ExpandMore';
import ExpandLessIcon from '@material-ui/icons/ExpandLess';
import FavoriteBorderIcon from '@material-ui/icons/FavoriteBorder';
import SecurityIcon from '@material-ui/icons/Security';
import StorageIcon from '@material-ui/icons/Storage';
import FindInPageIcon from '@material-ui/icons/FindInPage';
import { siApachekafka, siArgo, siKubernetes } from 'simple-icons';
import { createIcon } from '@dweber019/backstage-plugin-simple-icons';

const ApacheKafkaIcon = createIcon(siApachekafka, false);
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

const S3LogExtractSidebarItem = () => {
  const discoveryApi = useApi(discoveryApiRef);
  const fetchApi = useApi(fetchApiRef);
  const [pendingCount, setPendingCount] = useState(0);

  useEffect(() => {
    const fetchPending = async () => {
      try {
        const baseUrl = await discoveryApi.getBaseUrl('s3-log-extract');
        const response = await fetchApi.fetch(`${baseUrl}/requests`);
        const data = await response.json();
        setPendingCount(
          data.filter((r: any) => r.status === 'pending').length,
        );
      } catch {
        /* ignore */
      }
    };
    fetchPending();
    const interval = setInterval(fetchPending, 15_000);
    return () => clearInterval(interval);
  }, [discoveryApi, fetchApi]);

  return (
    <SidebarItem icon={FindInPageIcon} to="s3-log-extract" text="S3 Log Extract">
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

const PlatformsSidebarItem = () => {
  const configApi = useApi(configApiRef);
  const platformsCount = (configApi.getOptionalConfigArray('app.platforms') ?? []).length;

  return (
    <SidebarItem icon={KubernetesIcon} to="platforms" text="Platforms">
      <span
        className={
          platformsCount > 0 ? 'sidebar-badge' : 'sidebar-badge sidebar-badge-zero'
        }
      >
        {platformsCount}
      </span>
    </SidebarItem>
  );
};

export const Root = ({ children }: PropsWithChildren<{}>) => {
  const config = useApi(configApiRef);
  const catalogHealthEnabled = config.getOptionalBoolean('app.plugins.catalogHealth') ?? true;
  const argocdAppSetEnabled = config.getOptionalBoolean('app.plugins.argocdAppSet') ?? true;
  const iamUserAuditEnabled = config.getOptionalBoolean('app.plugins.iamUserAudit') ?? true;
  const kafkaTopicEnabled = config.getOptionalBoolean('app.plugins.kafkaTopic') ?? true;
  const s3LogExtractEnabled = config.getOptionalBoolean('app.plugins.s3LogExtract') ?? true;

  return (
  <SidebarPage>
    <Sidebar>
      <SidebarLogo />
      <SidebarGroup label="Search" icon={<SearchIcon />} to="/search">
        <SidebarSearchModal />
      </SidebarGroup>
      <SidebarDivider />

      {/* Resources Section */}
      <FoldableSection title="Resources" icon={<CategoryIcon />} defaultOpen={false}>
        <PlatformsSidebarItem />
        <SidebarItem icon={CategoryIcon} to="catalog" text="Catalog" />
        <SidebarItem icon={ExtensionIcon} to="api-docs" text="APIs" />
        <SidebarItem icon={CloudUploadIcon} to="openapi-registry" text="API Registry" />
        <SidebarItem icon={LibraryBooks} to="docs" text="Docs" />
      </FoldableSection>

      {/* Operations Section */}
      <FoldableSection title="Operations" icon={<BuildIcon />} defaultOpen={false}>
        {catalogHealthEnabled && (
          <SidebarItem icon={FavoriteBorderIcon} to="catalog-health" text="Catalog Health" />
        )}
        {argocdAppSetEnabled && (
          <SidebarItem icon={ArgocdIcon} to="argocd-appset" text="ArgoCD" />
        )}
        {kafkaTopicEnabled && (
          <SidebarItem icon={ApacheKafkaIcon} to="kafka-topic" text="Kafka Topic" />
        )}
        {iamUserAuditEnabled && <IamAuditSidebarItem />}
        {s3LogExtractEnabled && <S3LogExtractSidebarItem />}
      </FoldableSection>

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
