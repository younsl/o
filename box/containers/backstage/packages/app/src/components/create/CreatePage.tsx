import React from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Content,
  ContentHeader,
  Header,
  Page,
} from '@backstage/core-components';
import {
  Card,
  CardActionArea,
  CardContent,
  Grid,
  Typography,
  makeStyles,
} from '@material-ui/core';
import PublishIcon from '@material-ui/icons/Publish';
import NoteAddIcon from '@material-ui/icons/NoteAdd';

const useStyles = makeStyles(theme => ({
  card: {
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
  },
  cardContent: {
    flexGrow: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    textAlign: 'center',
    padding: theme.spacing(3),
  },
  icon: {
    fontSize: 48,
    marginBottom: theme.spacing(2),
    color: theme.palette.primary.main,
  },
  title: {
    marginBottom: theme.spacing(1),
  },
}));

export const CreatePage = () => {
  const classes = useStyles();
  const navigate = useNavigate();

  const cards = [
    {
      title: 'Register Existing Component',
      description: 'Register an existing component by providing a URL to its catalog-info.yaml file.',
      icon: <PublishIcon className={classes.icon} />,
      path: '/catalog-import',
    },
    {
      title: 'Create catalog-info.yaml',
      description: 'Create a catalog-info.yaml file in an existing repository via Merge Request.',
      icon: <NoteAddIcon className={classes.icon} />,
      path: '/create/templates',
    },
  ];

  return (
    <Page themeId="tool">
      <Header title="Create" subtitle="Register or create new components" />
      <Content>
        <ContentHeader title="" />
        <Grid container spacing={3}>
          {cards.map(card => (
            <Grid item xs={12} sm={6} md={4} key={card.title}>
              <Card className={classes.card}>
                <CardActionArea onClick={() => navigate(card.path)}>
                  <CardContent className={classes.cardContent}>
                    {card.icon}
                    <Typography variant="h6" className={classes.title}>
                      {card.title}
                    </Typography>
                    <Typography variant="body2" color="textSecondary">
                      {card.description}
                    </Typography>
                  </CardContent>
                </CardActionArea>
              </Card>
            </Grid>
          ))}
        </Grid>
      </Content>
    </Page>
  );
};
