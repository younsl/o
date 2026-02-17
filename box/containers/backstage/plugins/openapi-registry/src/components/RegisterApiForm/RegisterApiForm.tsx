import React, { useState } from 'react';
import {
  Button,
  CircularProgress,
  FormControl,
  Grid,
  InputLabel,
  MenuItem,
  Select,
  TextField,
  Typography,
  makeStyles,
  Chip,
} from '@material-ui/core';
import { Alert } from '@material-ui/lab';
import { useApi } from '@backstage/core-plugin-api';
import { openApiRegistryApiRef } from '../../api';
import { PreviewResult, RegisterApiRequest } from '../../api/types';

// Backstage entity name validation: lowercase, numbers, hyphens, underscores, dots
// Must start and end with alphanumeric character
const ENTITY_NAME_PATTERN = /^[a-z0-9]([a-z0-9\-_.]*[a-z0-9])?$/;

const validateEntityName = (value: string): string | null => {
  if (!value) return null;
  if (value.length > 63) {
    return 'Name must be 63 characters or less';
  }
  if (!ENTITY_NAME_PATTERN.test(value)) {
    return 'Only lowercase letters, numbers, hyphens, underscores, and dots allowed';
  }
  return null;
};

const useStyles = makeStyles(theme => ({
  form: {
    width: '100%',
  },
  formControl: {
    marginBottom: theme.spacing(2),
    width: '100%',
  },
  previewBox: {
    backgroundColor: theme.palette.background.default,
    padding: theme.spacing(2),
    borderRadius: theme.shape.borderRadius,
    marginBottom: theme.spacing(2),
  },
  previewTitle: {
    fontWeight: 'bold',
    marginBottom: theme.spacing(1),
  },
  buttonGroup: {
    display: 'flex',
    gap: theme.spacing(2),
    marginTop: theme.spacing(2),
  },
  tagsInput: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: theme.spacing(0.5),
    marginTop: theme.spacing(1),
  },
}));

export interface RegisterApiFormProps {
  onSuccess?: () => void;
}

export const RegisterApiForm = ({ onSuccess }: RegisterApiFormProps) => {
  const classes = useStyles();
  const api = useApi(openApiRegistryApiRef);

  const [protocol, setProtocol] = useState('https://');
  const [specUrl, setSpecUrl] = useState('');
  const [name, setName] = useState('');
  const [title, setTitle] = useState('');
  const [owner, setOwner] = useState('');
  const [lifecycle, setLifecycle] = useState('development');
  const [tags, setTags] = useState<string[]>(['openapi', 'rest']);
  const [tagInput, setTagInput] = useState('');

  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);

  const getFullSpecUrl = () => `${protocol}${specUrl}`;

  const handlePreview = async () => {
    if (!specUrl) {
      setError('Please enter a spec URL');
      return;
    }

    setIsLoading(true);
    setError(null);
    setPreview(null);

    try {
      const result = await api.previewSpec(getFullSpecUrl());
      setPreview(result);

      if (result.valid && result.name) {
        setName(result.name);
        setNameError(validateEntityName(result.name));
        setTitle(result.title || '');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to preview spec');
    } finally {
      setIsLoading(false);
    }
  };

  const handleNameChange = (value: string) => {
    setName(value);
    setNameError(validateEntityName(value));
  };

  const handleRegister = async () => {
    if (!specUrl || !name || !owner || !lifecycle) {
      setError('Please fill in all required fields');
      return;
    }

    const validationError = validateEntityName(name);
    if (validationError) {
      setNameError(validationError);
      return;
    }

    setIsLoading(true);
    setError(null);
    setSuccess(null);

    try {
      const request: RegisterApiRequest = {
        specUrl: getFullSpecUrl(),
        name,
        title: title || undefined,
        owner,
        lifecycle,
        tags: tags.length > 0 ? tags : undefined,
      };

      await api.registerApi(request);
      setSuccess(`API "${name}" registered successfully! The entity will appear in the Catalog within 1-2 minutes.`);

      // Reset form
      setProtocol('https://');
      setSpecUrl('');
      setName('');
      setTitle('');
      setOwner('');
      setLifecycle('development');
      setTags(['openapi', 'rest']);
      setPreview(null);

      onSuccess?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to register API');
    } finally {
      setIsLoading(false);
    }
  };

  const handleAddTag = () => {
    if (tagInput && !tags.includes(tagInput)) {
      setTags([...tags, tagInput]);
      setTagInput('');
    }
  };

  const handleRemoveTag = (tagToRemove: string) => {
    setTags(tags.filter(tag => tag !== tagToRemove));
  };

  return (
    <div className={classes.form}>
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

      <Grid container spacing={2}>
        <Grid item xs={12}>
          <Grid container spacing={1} alignItems="flex-start">
            <Grid item xs={12} sm={2}>
              <FormControl variant="outlined" fullWidth>
                <InputLabel>Protocol</InputLabel>
                <Select
                  value={protocol}
                  onChange={e => setProtocol(e.target.value as string)}
                  label="Protocol"
                >
                  <MenuItem value="https://">https://</MenuItem>
                  <MenuItem value="http://">http://</MenuItem>
                </Select>
              </FormControl>
            </Grid>
            <Grid item xs={12} sm={10}>
              <TextField
                fullWidth
                label="OpenAPI Spec URL"
                placeholder="petstore.swagger.io/v2/swagger.json"
                value={specUrl}
                onChange={e => setSpecUrl(e.target.value)}
                variant="outlined"
                required
                helperText={
                  <>
                    Enter the URL of an OpenAPI or Swagger spec (JSON or YAML)
                    <br />
                    Test URLs: <code>petstore.swagger.io/v2/swagger.json</code> | <code>petstore3.swagger.io/api/v3/openapi.json</code>
                  </>
                }
              />
            </Grid>
          </Grid>
        </Grid>

        <Grid item xs={12}>
          <div className={classes.buttonGroup}>
            <Button
              variant="outlined"
              color="primary"
              onClick={handlePreview}
              disabled={isLoading || !specUrl}
            >
              {isLoading ? <CircularProgress size={24} /> : 'Preview'}
            </Button>
          </div>
        </Grid>

        {preview && (
          <Grid item xs={12}>
            <div className={classes.previewBox}>
              <Typography className={classes.previewTitle}>
                Preview {preview.valid ? '✓' : '✗'}
              </Typography>
              {preview.valid ? (
                <>
                  <Typography>
                    <strong>Title:</strong> {preview.title}
                  </Typography>
                  <Typography>
                    <strong>Version:</strong> {preview.version}
                  </Typography>
                  {preview.description && (
                    <Typography>
                      <strong>Description:</strong> {preview.description}
                    </Typography>
                  )}
                  <Typography>
                    <strong>Spec:</strong>{' '}
                    {preview.spec?.openapi
                      ? `OpenAPI ${preview.spec.openapi}`
                      : `Swagger ${preview.spec?.swagger}`}
                  </Typography>
                </>
              ) : (
                <Typography color="error">{preview.error}</Typography>
              )}
            </div>
          </Grid>
        )}

        {preview?.valid && (
          <>
            <Grid item xs={12} md={6}>
              <TextField
                className={classes.formControl}
                label="API Name"
                value={name}
                onChange={e => handleNameChange(e.target.value)}
                variant="outlined"
                required
                error={!!nameError}
                helperText={nameError || 'Lowercase letters, numbers, hyphens, underscores only'}
              />
            </Grid>

            <Grid item xs={12} md={6}>
              <TextField
                className={classes.formControl}
                label="Title"
                value={title}
                onChange={e => setTitle(e.target.value)}
                variant="outlined"
                helperText="Display name for this API"
              />
            </Grid>

            <Grid item xs={12} md={6}>
              <TextField
                className={classes.formControl}
                label="Owner"
                value={owner}
                onChange={e => setOwner(e.target.value)}
                variant="outlined"
                required
                placeholder="team-platform"
                helperText="Team or user that owns this API"
              />
            </Grid>

            <Grid item xs={12} md={6}>
              <FormControl variant="outlined" className={classes.formControl}>
                <InputLabel>Lifecycle</InputLabel>
                <Select
                  value={lifecycle}
                  onChange={e => setLifecycle(e.target.value as string)}
                  label="Lifecycle"
                >
                  <MenuItem value="development">Development</MenuItem>
                  <MenuItem value="sandbox">Sandbox</MenuItem>
                  <MenuItem value="staging">Staging</MenuItem>
                  <MenuItem value="production">Production</MenuItem>
                  <MenuItem value="deprecated">Deprecated</MenuItem>
                </Select>
              </FormControl>
            </Grid>

            <Grid item xs={12}>
              <TextField
                label="Add Tag"
                value={tagInput}
                onChange={e => setTagInput(e.target.value)}
                onKeyPress={e => e.key === 'Enter' && handleAddTag()}
                variant="outlined"
                size="small"
                helperText="Press Enter to add a tag"
              />
              <div className={classes.tagsInput}>
                {tags.map(tag => (
                  <Chip
                    key={tag}
                    label={tag}
                    onDelete={() => handleRemoveTag(tag)}
                    size="small"
                  />
                ))}
              </div>
            </Grid>

            <Grid item xs={12}>
              <div className={classes.buttonGroup}>
                <Button
                  variant="contained"
                  color="primary"
                  onClick={handleRegister}
                  disabled={isLoading || !name || !owner || !!nameError}
                >
                  {isLoading ? <CircularProgress size={24} /> : 'Register API'}
                </Button>
              </div>
            </Grid>
          </>
        )}
      </Grid>
    </div>
  );
};
