import React, { useState } from 'react';
import { Alert, Button, Flex, Grid as BuiGrid, Select, Text, TextField, Box } from '@backstage/ui';
import { useApi } from '@backstage/core-plugin-api';
import { openApiRegistryApiRef } from '../../api';
import { PreviewResult, RegisterApiRequest } from '../../api/types';

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

const protocolOptions = [
  { value: 'https://', label: 'https://' },
  { value: 'http://', label: 'http://' },
];

const lifecycleOptions = [
  { value: 'development', label: 'Development' },
  { value: 'sandbox', label: 'Sandbox' },
  { value: 'staging', label: 'Staging' },
  { value: 'production', label: 'Production' },
  { value: 'deprecated', label: 'Deprecated' },
];

export interface RegisterApiFormProps {
  onSuccess?: () => void;
}

export const RegisterApiForm = ({ onSuccess }: RegisterApiFormProps) => {
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
    <Flex direction="column" gap="3">
      {error && <Alert status="danger" description={error} mb="2" />}
      {success && <Alert status="success" description={success} mb="2" />}

      {/* Protocol + Spec URL */}
      <Flex gap="2" direction={{ initial: 'column', sm: 'row' }} align="end">
        <Box style={{ minWidth: 140 }}>
          <Select
            label="Protocol"
            options={protocolOptions}
            selectedKey={protocol}
            onSelectionChange={(key) => setProtocol(key as string)}
          />
        </Box>
        <Box style={{ flex: 1 }}>
          <TextField
            label="OpenAPI Spec URL"
            placeholder="petstore.swagger.io/v2/swagger.json"
            value={specUrl}
            onChange={setSpecUrl}
            isRequired
          />
        </Box>
      </Flex>
      <Text variant="body-x-small" color="secondary">
        Enter the URL of an OpenAPI or Swagger spec (JSON or YAML). Test: petstore.swagger.io/v2/swagger.json
      </Text>

      {/* Preview button */}
      <Flex>
        <Button
          variant="secondary"
          onPress={handlePreview}
          isDisabled={isLoading || !specUrl}
          loading={isLoading && !preview}
        >
          Preview
        </Button>
      </Flex>

      {/* Preview result */}
      {preview && (
        <Box p="3" style={{ backgroundColor: 'var(--bui-color-bg-default, #121212)', borderRadius: 4 }}>
          <Text weight="bold">
            Preview {preview.valid ? '✓' : '✗'}
          </Text>
          {preview.valid ? (
            <Flex direction="column" gap="0.5" mt="1">
              <Text variant="body-small"><strong>Title:</strong> {preview.title}</Text>
              <Text variant="body-small"><strong>Version:</strong> {preview.version}</Text>
              {preview.description && (
                <Text variant="body-small"><strong>Description:</strong> {preview.description}</Text>
              )}
              <Text variant="body-small">
                <strong>Spec:</strong>{' '}
                {preview.spec?.openapi
                  ? `OpenAPI ${preview.spec.openapi}`
                  : `Swagger ${preview.spec?.swagger}`}
              </Text>
            </Flex>
          ) : (
            <Box mt="1">
              <Text color="danger">{preview.error}</Text>
            </Box>
          )}
        </Box>
      )}

      {/* Registration form fields (shown after valid preview) */}
      {preview?.valid && (
        <>
          <BuiGrid.Root columns={{ initial: '1', md: '2' }} gap="3">
            <TextField
              label="API Name"
              value={name}
              onChange={handleNameChange}
              isRequired
              isInvalid={!!nameError}
              description={nameError || 'Lowercase letters, numbers, hyphens, underscores only'}
            />
            <TextField
              label="Title"
              value={title}
              onChange={setTitle}
              description="Display name for this API"
            />
            <TextField
              label="Owner"
              value={owner}
              onChange={setOwner}
              isRequired
              placeholder="team-platform"
              description="Team or user that owns this API"
            />
            <Select
              label="Lifecycle"
              options={lifecycleOptions}
              selectedKey={lifecycle}
              onSelectionChange={(key) => setLifecycle(key as string)}
              description="Current stage of this API"
            />
          </BuiGrid.Root>

          {/* Tags */}
          <div onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              handleAddTag();
            }
          }}>
            <TextField
              label="Add Tag"
              value={tagInput}
              onChange={setTagInput}
              size="small"
              description="Press Enter to add a tag"
            />
          </div>
          {tags.length > 0 && (
            <Flex gap="1" style={{ flexWrap: 'wrap' }}>
              {tags.map(tag => (
                <span
                  key={tag}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                    padding: '2px 8px',
                    borderRadius: 4,
                    fontSize: 12,
                    backgroundColor: 'var(--bui-color-bg-elevated, #2a2a2a)',
                    border: '1px solid var(--bui-color-border-default, #444)',
                  }}
                >
                  {tag}
                  <button
                    type="button"
                    aria-label={`Remove ${tag}`}
                    onClick={() => handleRemoveTag(tag)}
                    style={{
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      padding: 0,
                      lineHeight: 1,
                      fontSize: 14,
                      color: 'inherit',
                      opacity: 0.6,
                    }}
                  >
                    ✕
                  </button>
                </span>
              ))}
            </Flex>
          )}

          {/* Register button */}
          <Flex>
            <Button
              variant="primary"
              onPress={handleRegister}
              isDisabled={isLoading || !name || !owner || !!nameError}
              loading={isLoading}
            >
              Register API
            </Button>
          </Flex>
        </>
      )}
    </Flex>
  );
};
