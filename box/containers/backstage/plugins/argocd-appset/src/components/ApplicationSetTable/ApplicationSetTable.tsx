import React, { useState, useMemo, useCallback } from 'react';
import {
  Card,
  CardContent,
  CircularProgress,
  Divider,
  Typography,
  makeStyles,
  Chip,
  TextField,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Grid,
  InputAdornment,
  IconButton,
  Box,
  Tooltip,
  Link,
} from '@material-ui/core';
import SearchIcon from '@material-ui/icons/Search';
import ClearIcon from '@material-ui/icons/Clear';
import NotificationsIcon from '@material-ui/icons/Notifications';
import NotificationsOffIcon from '@material-ui/icons/NotificationsOff';
import { Alert } from '@material-ui/lab';
import { useApi } from '@backstage/core-plugin-api';
import { useAsyncRetry } from 'react-use';
import { argocdAppsetApiRef, ApplicationSetResponse } from '../../api';

const useStyles = makeStyles(theme => ({
  section: {
    marginBottom: theme.spacing(4),
  },
  sectionTitle: {
    fontSize: '0.875rem',
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
    color: theme.palette.text.secondary,
    marginBottom: theme.spacing(2),
  },
  divider: {
    marginBottom: theme.spacing(4),
  },
  summaryBar: {
    display: 'flex',
    gap: theme.spacing(2),
    flexWrap: 'wrap',
  },
  summaryCard: {
    display: 'flex',
    alignItems: 'center',
    padding: theme.spacing(1.5, 2),
    borderRadius: theme.shape.borderRadius,
    backgroundColor: theme.palette.type === 'dark'
      ? 'rgba(255, 255, 255, 0.05)'
      : 'rgba(0, 0, 0, 0.02)',
    border: `1px solid ${theme.palette.divider}`,
  },
  summaryValue: {
    fontWeight: 700,
    fontSize: '1.25rem',
    marginRight: theme.spacing(1),
  },
  summaryLabel: {
    fontSize: '0.8rem',
    color: theme.palette.text.secondary,
  },
  filterBar: {
    marginBottom: theme.spacing(3),
  },
  searchField: {
    minWidth: 300,
  },
  filterSelect: {
    minWidth: 150,
  },
  emptyState: {
    textAlign: 'center',
    padding: theme.spacing(4),
  },
  loadingState: {
    display: 'flex',
    justifyContent: 'center',
    padding: theme.spacing(4),
  },
  card: {
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
  },
  cardWarning: {
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    borderLeft: `4px solid ${theme.palette.warning.main}`,
  },
  cardHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: theme.spacing(1.5),
  },
  cardName: {
    fontWeight: 600,
    fontSize: '1rem',
    wordBreak: 'break-word',
  },
  appCountBadge: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    flexShrink: 0,
    marginLeft: theme.spacing(1),
  },
  appCountNumber: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 36,
    height: 36,
    borderRadius: '50%',
    backgroundColor: theme.palette.type === 'dark'
      ? 'rgba(255, 255, 255, 0.08)'
      : 'rgba(0, 0, 0, 0.04)',
    fontWeight: 700,
    fontSize: '0.875rem',
  },
  appCountLabel: {
    fontSize: '0.625rem',
    color: theme.palette.text.hint,
    textTransform: 'uppercase',
    marginTop: 2,
  },
  fieldLabel: {
    fontSize: '0.75rem',
    color: theme.palette.text.secondary,
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
    marginBottom: theme.spacing(0.5),
  },
  fieldRow: {
    marginBottom: theme.spacing(1.5),
  },
  chips: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: theme.spacing(0.5),
  },
  namespace: {
    fontSize: '0.8rem',
    color: theme.palette.text.secondary,
  },
  cardFooter: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 'auto',
    paddingTop: theme.spacing(1.5),
    borderTop: `1px solid ${theme.palette.divider}`,
  },
  created: {
    fontSize: '0.75rem',
    color: theme.palette.text.hint,
  },
}));

export const ApplicationSetTable = () => {
  const classes = useStyles();
  const api = useApi(argocdAppsetApiRef);

  const [searchQuery, setSearchQuery] = useState('');
  const [namespaceFilter, setNamespaceFilter] = useState<string>('all');
  const [revisionFilter, setRevisionFilter] = useState<string>('all');

  const [mutingKey, setMutingKey] = useState<string | null>(null);
  const [localAppSets, setLocalAppSets] = useState<ApplicationSetResponse[] | undefined>(undefined);

  const {
    value: appSetsRaw,
    loading,
    error: loadError,
  } = useAsyncRetry(async () => {
    return api.listApplicationSets();
  }, []);

  const appSets = localAppSets ?? appSetsRaw;

  const { value: status } = useAsyncRetry(async () => {
    return api.getStatus();
  }, []);

  const totalCount = appSets?.length ?? 0;
  const nonHeadCount = useMemo(() => {
    if (!appSets) return 0;
    return appSets.filter(a => !a.isHeadRevision).length;
  }, [appSets]);
  const totalApps = useMemo(() => {
    if (!appSets) return 0;
    return appSets.reduce((sum, a) => sum + a.applicationCount, 0);
  }, [appSets]);
  const mutedCount = useMemo(() => {
    if (!appSets) return 0;
    return appSets.filter(a => a.muted).length;
  }, [appSets]);

  const uniqueNamespaces = useMemo(() => {
    if (!appSets) return [];
    return [...new Set(appSets.map(a => a.namespace))].sort();
  }, [appSets]);

  const uniqueRevisions = useMemo(() => {
    if (!appSets) return [];
    return [...new Set(appSets.flatMap(a => a.targetRevisions))].sort();
  }, [appSets]);

  const filteredAppSets = useMemo(() => {
    if (!appSets) return [];
    return appSets
      .filter(a => {
        const matchesSearch =
          searchQuery === '' ||
          a.name.toLowerCase().includes(searchQuery.toLowerCase());
        const matchesNamespace =
          namespaceFilter === 'all' || a.namespace === namespaceFilter;
        const matchesRevision =
          revisionFilter === 'all' || a.targetRevisions.includes(revisionFilter);
        return matchesSearch && matchesNamespace && matchesRevision;
      })
      .sort((a, b) => Number(a.isHeadRevision) - Number(b.isHeadRevision));
  }, [appSets, searchQuery, namespaceFilter, revisionFilter]);

  const formatDate = (dateString: string) => {
    if (!dateString) return '-';
    return new Date(dateString).toLocaleString();
  };

  const handleToggleMute = useCallback(async (namespace: string, name: string, muted: boolean) => {
    const key = `${namespace}/${name}`;
    setMutingKey(key);
    try {
      if (muted) {
        await api.unmute(namespace, name);
      } else {
        await api.mute(namespace, name);
      }
      // Optimistic update: toggle muted state locally without re-fetching
      setLocalAppSets(prev => {
        const source = prev ?? appSetsRaw;
        if (!source) return source;
        return source.map(a =>
          a.namespace === namespace && a.name === name
            ? { ...a, muted: !muted }
            : a,
        );
      });
    } catch {
      // silently fail — next fetch cycle will reflect actual state
    } finally {
      setMutingKey(null);
    }
  }, [api, appSetsRaw]);

  if (loading) {
    return (
      <div className={classes.loadingState}>
        <CircularProgress />
      </div>
    );
  }

  if (loadError) {
    return (
      <Alert severity="error">
        Failed to load ApplicationSets: {loadError.message}
      </Alert>
    );
  }

  if (!appSets || appSets.length === 0) {
    return (
      <div className={classes.emptyState}>
        <Typography variant="h6" color="textSecondary">
          No ApplicationSets found
        </Typography>
        <Typography variant="body2" color="textSecondary">
          Ensure the backend has access to the Kubernetes cluster with ArgoCD
          ApplicationSets
        </Typography>
      </div>
    );
  }

  return (
    <>
      {/* Summary Section */}
      <div className={classes.section}>
        <Typography className={classes.sectionTitle}>Overview</Typography>
        <div className={classes.summaryBar}>
          <div className={classes.summaryCard}>
            <Typography className={classes.summaryValue}>{totalCount}</Typography>
            <Typography className={classes.summaryLabel}>ApplicationSets</Typography>
          </div>
          <div className={classes.summaryCard}>
            <Typography className={classes.summaryValue}>{totalApps}</Typography>
            <Typography className={classes.summaryLabel}>Total Apps</Typography>
          </div>
          <div className={classes.summaryCard}>
            <Typography className={classes.summaryValue} color={nonHeadCount > 0 ? 'secondary' : 'inherit'}>{nonHeadCount}</Typography>
            <Typography className={classes.summaryLabel}>Not HEAD</Typography>
          </div>
          <div className={classes.summaryCard}>
            <Typography className={classes.summaryValue}>{mutedCount}</Typography>
            <Typography className={classes.summaryLabel}>Muted</Typography>
          </div>
          {status && (
            <div className={classes.summaryCard}>
              <Chip
                label={status.cron}
                size="small"
                variant="outlined"
                style={{ marginRight: 8 }}
              />
              <Typography className={classes.summaryLabel}>
                Schedule {status.slackConfigured ? '(Slack ON)' : '(Slack OFF)'}
              </Typography>
            </div>
          )}
          {status?.lastFetchedAt && (
            <div className={classes.summaryCard}>
              <Typography className={classes.summaryLabel}>
                Last fetched {new Date(status.lastFetchedAt).toLocaleString()}
              </Typography>
            </div>
          )}
        </div>
      </div>

      <Divider className={classes.divider} />

      {/* ApplicationSets Section */}
      <div>
        <Typography className={classes.sectionTitle}>ApplicationSets</Typography>

        <Grid
          container
          spacing={2}
          className={classes.filterBar}
          alignItems="center"
        >
          <Grid item>
            <TextField
              className={classes.searchField}
              placeholder="Search by name..."
              variant="outlined"
              size="small"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              InputProps={{
                startAdornment: (
                  <InputAdornment position="start">
                    <SearchIcon color="disabled" />
                  </InputAdornment>
                ),
                endAdornment: searchQuery && (
                  <InputAdornment position="end">
                    <IconButton
                      size="small"
                      onClick={() => setSearchQuery('')}
                      aria-label="clear search"
                    >
                      <ClearIcon fontSize="small" />
                    </IconButton>
                  </InputAdornment>
                ),
              }}
            />
          </Grid>
          <Grid item>
            <FormControl
              variant="outlined"
              size="small"
              className={classes.filterSelect}
            >
              <InputLabel>Namespace</InputLabel>
              <Select
                value={namespaceFilter}
                onChange={e => setNamespaceFilter(e.target.value as string)}
                label="Namespace"
              >
                <MenuItem value="all">All</MenuItem>
                {uniqueNamespaces.map(ns => (
                  <MenuItem key={ns} value={ns}>
                    {ns}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          </Grid>
          <Grid item>
            <FormControl
              variant="outlined"
              size="small"
              className={classes.filterSelect}
            >
              <InputLabel>Target Revision</InputLabel>
              <Select
                value={revisionFilter}
                onChange={e => setRevisionFilter(e.target.value as string)}
                label="Target Revision"
              >
                <MenuItem value="all">All</MenuItem>
                {uniqueRevisions.map(rev => (
                  <MenuItem key={rev} value={rev}>
                    {rev}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          </Grid>
        </Grid>

        {filteredAppSets.length === 0 ? (
          <div className={classes.emptyState}>
            <Typography variant="body1" color="textSecondary">
              No ApplicationSets match the current filters
            </Typography>
          </div>
        ) : (
          <Grid container spacing={2}>
            {filteredAppSets.map(appSet => (
              <Grid
                item
                xs={12}
                sm={6}
                md={3}
                key={`${appSet.namespace}/${appSet.name}`}
              >
                <Card
                  className={
                    appSet.isHeadRevision ? classes.card : classes.cardWarning
                  }
                  variant="outlined"
                >
                  <CardContent>
                    <div className={classes.cardHeader}>
                      <Box>
                        <Typography className={classes.cardName}>
                          {appSet.name}
                        </Typography>
                        <Typography className={classes.namespace}>
                          {appSet.namespace}
                        </Typography>
                      </Box>
                      <div className={classes.appCountBadge}>
                        <div className={classes.appCountNumber}>
                          {appSet.applicationCount}
                        </div>
                        <Typography className={classes.appCountLabel}>
                          Apps
                        </Typography>
                      </div>
                    </div>

                    <div className={classes.fieldRow}>
                      <Typography className={classes.fieldLabel}>
                        Generators
                      </Typography>
                      <div className={classes.chips}>
                        {appSet.generators.map((gen, i) => (
                          <Chip
                            key={i}
                            label={gen}
                            size="small"
                            variant="outlined"
                          />
                        ))}
                      </div>
                    </div>

                    {appSet.repoName && (
                      <div className={classes.fieldRow}>
                        <Typography className={classes.fieldLabel}>
                          Repository
                        </Typography>
                        <Typography variant="body2" noWrap>
                          {appSet.repoUrl ? (
                            <Link
                              href={appSet.repoUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              {appSet.repoName}
                            </Link>
                          ) : (
                            appSet.repoName
                          )}
                        </Typography>
                      </div>
                    )}

                    <div className={classes.fieldRow}>
                      <Typography className={classes.fieldLabel}>
                        Target Revision
                      </Typography>
                      <div className={classes.chips}>
                        {appSet.targetRevisions.map((rev, i) => (
                          <Chip
                            key={i}
                            label={rev}
                            size="small"
                            color={rev === 'HEAD' ? 'default' : 'secondary'}
                          />
                        ))}
                        {!appSet.isHeadRevision && (
                          <Chip
                            label="Not HEAD"
                            color="secondary"
                            size="small"
                          />
                        )}
                      </div>
                    </div>

                    <div className={classes.cardFooter}>
                      <Typography className={classes.created}>
                        Created {formatDate(appSet.createdAt)}
                      </Typography>
                      <Tooltip title={appSet.muted ? 'Unmute notifications' : 'Mute notifications'}>
                        <IconButton
                          size="small"
                          onClick={() => handleToggleMute(appSet.namespace, appSet.name, appSet.muted)}
                          disabled={mutingKey === `${appSet.namespace}/${appSet.name}`}
                        >
                          {mutingKey === `${appSet.namespace}/${appSet.name}` ? (
                            <CircularProgress size={18} />
                          ) : appSet.muted ? (
                            <NotificationsOffIcon fontSize="small" color="disabled" />
                          ) : (
                            <NotificationsIcon fontSize="small" />
                          )}
                        </IconButton>
                      </Tooltip>
                    </div>
                  </CardContent>
                </Card>
              </Grid>
            ))}
          </Grid>
        )}
      </div>
    </>
  );
};
