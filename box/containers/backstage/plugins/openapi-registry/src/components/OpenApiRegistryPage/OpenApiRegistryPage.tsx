import React, { useState } from 'react';
import { makeStyles, IconButton, Tooltip } from '@material-ui/core';
import HelpOutlineIcon from '@material-ui/icons/HelpOutline';
import { Header, HeaderLabel } from '@backstage/core-components';
import { Container, Flex, Text } from '@backstage/ui';
import { RegisterApiForm } from '../RegisterApiForm';
import { RegisteredApisList } from '../RegisteredApisList';

const useStyles = makeStyles(theme => ({
  content: {
    display: 'flex',
    flexDirection: 'column',
    gap: theme.spacing(4),
    padding: theme.spacing(3),
  },
  section: {
    backgroundColor: theme.palette.background.paper,
    padding: theme.spacing(3),
    borderRadius: theme.shape.borderRadius,
  },
  helpButton: {
    padding: 4,
    marginLeft: 1,
  },
  helpIcon: {
    fontSize: 20,
    color: theme.palette.text.secondary,
  },
}));

export const OpenApiRegistryPage = () => {
  const classes = useStyles();
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [apiCount, setApiCount] = useState(0);

  const handleRegisterSuccess = () => {
    setRefreshTrigger(prev => prev + 1);
  };

  return (
    <>
      <Header
        title="OpenAPI Registry"
        subtitle="Register external API specs from URL and sync them to Backstage Catalog automatically"
      >
        <HeaderLabel label="Owner" value="Platform Team" />
        <HeaderLabel label="Lifecycle" value="Production" />
      </Header>
      <Container>
        <div className={classes.content}>
          <Flex align="center">
            <Text variant="title-small">Register New API</Text>
            <Tooltip title="Register OpenAPI/Swagger specs by URL. The spec will be fetched, validated, and automatically synced to the Backstage Catalog as an API entity. Supports both JSON and YAML formats (OpenAPI 3.x and Swagger 2.0).">
              <IconButton className={classes.helpButton} size="small">
                <HelpOutlineIcon className={classes.helpIcon} />
              </IconButton>
            </Tooltip>
          </Flex>

          <div className={classes.section}>
            <RegisterApiForm onSuccess={handleRegisterSuccess} />
          </div>

          <Flex align="center">
            <Text variant="title-small">{`Registered APIs (${apiCount})`}</Text>
            <Tooltip title="List of registered APIs synced to the Backstage Catalog. You can refresh, view spec URL, or delete registrations.">
              <IconButton className={classes.helpButton} size="small">
                <HelpOutlineIcon className={classes.helpIcon} />
              </IconButton>
            </Tooltip>
          </Flex>

          <div className={classes.section}>
            <RegisteredApisList refreshTrigger={refreshTrigger} onCountChange={setApiCount} />
          </div>
        </div>
      </Container>
    </>
  );
};
