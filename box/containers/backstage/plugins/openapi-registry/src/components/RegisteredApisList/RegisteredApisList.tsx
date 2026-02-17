import React, { useState, useEffect, useMemo } from 'react';
import {
  Button,
  CircularProgress,
  IconButton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Tooltip,
  Typography,
  makeStyles,
  Chip,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions,
  TextField,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Grid,
  InputAdornment,
} from '@material-ui/core';
import SearchIcon from '@material-ui/icons/Search';
import ClearIcon from '@material-ui/icons/Clear';
import RefreshIcon from '@material-ui/icons/Refresh';
import DeleteIcon from '@material-ui/icons/Delete';
import OpenInNewIcon from '@material-ui/icons/OpenInNew';
import { Alert } from '@material-ui/lab';
import { useApi } from '@backstage/core-plugin-api';
import { useAsyncRetry } from 'react-use';
import { Link } from '@backstage/core-components';
import { openApiRegistryApiRef } from '../../api';
import { OpenApiRegistration } from '../../api/types';

const useStyles = makeStyles(theme => ({
  filterBar: {
    marginBottom: theme.spacing(3),
  },
  searchField: {
    minWidth: 300,
  },
  filterSelect: {
    minWidth: 150,
  },
  table: {
    minWidth: 650,
  },
  refreshButton: {
    marginRight: theme.spacing(1),
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
  urlCell: {
    maxWidth: 300,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  tagsCell: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: theme.spacing(0.5),
  },
  actionCell: {
    whiteSpace: 'nowrap',
  },
}));

export interface RegisteredApisListProps {
  refreshTrigger?: number;
  onCountChange?: (count: number) => void;
}

export const RegisteredApisList = ({ refreshTrigger, onCountChange }: RegisteredApisListProps) => {
  const classes = useStyles();
  const api = useApi(openApiRegistryApiRef);

  const [refreshingId, setRefreshingId] = useState<string | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deletingRegistration, setDeletingRegistration] =
    useState<OpenApiRegistration | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Filter states
  const [searchQuery, setSearchQuery] = useState('');
  const [lifecycleFilter, setLifecycleFilter] = useState<string>('all');
  const [ownerFilter, setOwnerFilter] = useState<string>('all');

  const {
    value: registrations,
    loading,
    error: loadError,
    retry,
  } = useAsyncRetry(async () => {
    return api.listRegistrations();
  }, [refreshTrigger]);

  // Get unique owners for filter dropdown
  const uniqueOwners = useMemo(() => {
    if (!registrations) return [];
    return [...new Set(registrations.map(r => r.owner))].sort();
  }, [registrations]);

  // Filter registrations
  const filteredRegistrations = useMemo(() => {
    if (!registrations) return [];
    return registrations.filter(r => {
      const matchesSearch = searchQuery === '' ||
        r.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        r.title?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        r.owner.toLowerCase().includes(searchQuery.toLowerCase());
      const matchesLifecycle = lifecycleFilter === 'all' || r.lifecycle === lifecycleFilter;
      const matchesOwner = ownerFilter === 'all' || r.owner === ownerFilter;
      return matchesSearch && matchesLifecycle && matchesOwner;
    });
  }, [registrations, searchQuery, lifecycleFilter, ownerFilter]);

  useEffect(() => {
    if (onCountChange) {
      onCountChange(filteredRegistrations?.length ?? 0);
    }
  }, [filteredRegistrations, onCountChange]);

  const handleRefresh = async (registration: OpenApiRegistration) => {
    setRefreshingId(registration.id);
    setError(null);
    setSuccess(null);

    try {
      await api.refreshApi(registration.id);
      setSuccess(`API "${registration.name}" refreshed. Changes will reflect in the Catalog shortly.`);
      retry();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to refresh API',
      );
    } finally {
      setRefreshingId(null);
    }
  };

  const handleDeleteClick = (registration: OpenApiRegistration) => {
    setDeletingRegistration(registration);
    setDeleteDialogOpen(true);
  };

  const handleDeleteConfirm = async () => {
    if (!deletingRegistration) return;

    setError(null);

    try {
      await api.deleteRegistration(deletingRegistration.id);
      setDeleteDialogOpen(false);
      setDeletingRegistration(null);
      retry();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to delete registration',
      );
    }
  };

  const handleDeleteCancel = () => {
    setDeleteDialogOpen(false);
    setDeletingRegistration(null);
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleString();
  };

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
        Failed to load registrations: {loadError.message}
      </Alert>
    );
  }

  if (!registrations || registrations.length === 0) {
    return (
      <div className={classes.emptyState}>
        <Typography variant="h6" color="textSecondary">
          No APIs registered yet
        </Typography>
        <Typography variant="body2" color="textSecondary">
          Register your first API using the form above
        </Typography>
      </div>
    );
  }

  return (
    <>
      {error && (
        <Alert severity="error" style={{ marginBottom: 16 }}>
          {error}
        </Alert>
      )}
      {success && (
        <Alert severity="success" style={{ marginBottom: 16 }}>
          {success}
        </Alert>
      )}

      {/* Filter Bar */}
      <Grid container spacing={2} className={classes.filterBar} alignItems="center">
        <Grid item>
          <TextField
            className={classes.searchField}
            placeholder="Search by name, title, or owner..."
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
          <FormControl variant="outlined" size="small" className={classes.filterSelect}>
            <InputLabel>Lifecycle</InputLabel>
            <Select
              value={lifecycleFilter}
              onChange={e => setLifecycleFilter(e.target.value as string)}
              label="Lifecycle"
            >
              <MenuItem value="all">All</MenuItem>
              <MenuItem value="production">Production</MenuItem>
              <MenuItem value="staging">Staging</MenuItem>
              <MenuItem value="development">Development</MenuItem>
              <MenuItem value="deprecated">Deprecated</MenuItem>
            </Select>
          </FormControl>
        </Grid>
        <Grid item>
          <FormControl variant="outlined" size="small" className={classes.filterSelect}>
            <InputLabel>Owner</InputLabel>
            <Select
              value={ownerFilter}
              onChange={e => setOwnerFilter(e.target.value as string)}
              label="Owner"
            >
              <MenuItem value="all">All</MenuItem>
              {uniqueOwners.map(owner => (
                <MenuItem key={owner} value={owner}>{owner}</MenuItem>
              ))}
            </Select>
          </FormControl>
        </Grid>
      </Grid>

      {filteredRegistrations.length === 0 ? (
        <div className={classes.emptyState}>
          <Typography variant="body1" color="textSecondary">
            No APIs match the current filters
          </Typography>
        </div>
      ) : (
      <Table className={classes.table}>
        <TableHead>
          <TableRow>
            <TableCell>Name</TableCell>
            <TableCell>Title</TableCell>
            <TableCell>Owner</TableCell>
            <TableCell>Lifecycle</TableCell>
            <TableCell>Tags</TableCell>
            <TableCell>Registered At</TableCell>
            <TableCell>Last Synced</TableCell>
            <TableCell>Actions</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {filteredRegistrations.map(registration => (
            <TableRow key={registration.id}>
              <TableCell>
                <Link to={`/catalog/default/api/${registration.name}`}>
                  {registration.name}
                </Link>
              </TableCell>
              <TableCell>{registration.title || '-'}</TableCell>
              <TableCell>{registration.owner}</TableCell>
              <TableCell>
                <Chip
                  label={registration.lifecycle}
                  size="small"
                  color={
                    registration.lifecycle === 'production'
                      ? 'primary'
                      : 'default'
                  }
                />
              </TableCell>
              <TableCell>
                <div className={classes.tagsCell}>
                  {registration.tags?.map(tag => (
                    <Chip key={tag} label={tag} size="small" variant="outlined" />
                  ))}
                </div>
              </TableCell>
              <TableCell>{formatDate(registration.createdAt)}</TableCell>
              <TableCell>{formatDate(registration.lastSyncedAt)}</TableCell>
              <TableCell className={classes.actionCell}>
                <Tooltip title="Refresh API spec">
                  <IconButton
                    size="small"
                    className={classes.refreshButton}
                    onClick={() => handleRefresh(registration)}
                    disabled={refreshingId === registration.id}
                  >
                    {refreshingId === registration.id ? (
                      <CircularProgress size={20} />
                    ) : (
                      <RefreshIcon />
                    )}
                  </IconButton>
                </Tooltip>
                <Tooltip title="View spec URL">
                  <IconButton
                    size="small"
                    className={classes.refreshButton}
                    href={registration.specUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <OpenInNewIcon />
                  </IconButton>
                </Tooltip>
                <Tooltip title="Delete registration">
                  <IconButton
                    size="small"
                    onClick={() => handleDeleteClick(registration)}
                  >
                    <DeleteIcon />
                  </IconButton>
                </Tooltip>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      )}

      <Dialog open={deleteDialogOpen} onClose={handleDeleteCancel}>
        <DialogTitle>Delete API Registration</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Are you sure you want to delete the registration for "
            {deletingRegistration?.name}"? This will also remove the API entity
            from the catalog.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={handleDeleteCancel}>Cancel</Button>
          <Button onClick={handleDeleteConfirm} color="secondary">
            Delete
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
};
