import React, { useState } from 'react';
import { makeStyles } from '@material-ui/core';
import {
  Content,
  ContentHeader,
  Header,
  HeaderLabel,
  Page,
  SupportButton,
} from '@backstage/core-components';
import { RegisterApiForm } from '../RegisterApiForm';
import { RegisteredApisList } from '../RegisteredApisList';

const useStyles = makeStyles(theme => ({
  content: {
    display: 'flex',
    flexDirection: 'column',
    gap: theme.spacing(4),
  },
  section: {
    backgroundColor: theme.palette.background.paper,
    padding: theme.spacing(3),
    borderRadius: theme.shape.borderRadius,
  },
  sectionTitle: {
    marginBottom: theme.spacing(2),
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
    <Page themeId="tool">
      <Header
        title="OpenAPI Registry"
        subtitle="Register external API specs from URL and sync them to Backstage Catalog automatically"
      >
        <HeaderLabel label="Owner" value="Platform Team" />
        <HeaderLabel label="Lifecycle" value="Production" />
      </Header>
      <Content className={classes.content}>
        <ContentHeader title="Register New API">
          <SupportButton>
            Register OpenAPI/Swagger specs by URL. The spec will be fetched,
            validated, and automatically synced to the Backstage Catalog as an
            API entity. Supports both JSON and YAML formats (OpenAPI 3.x and Swagger 2.0).
          </SupportButton>
        </ContentHeader>

        <div className={classes.section}>
          <RegisterApiForm onSuccess={handleRegisterSuccess} />
        </div>

        <ContentHeader title={`Registered APIs (${apiCount})`} />

        <div className={classes.section}>
          <RegisteredApisList refreshTrigger={refreshTrigger} onCountChange={setApiCount} />
        </div>
      </Content>
    </Page>
  );
};
