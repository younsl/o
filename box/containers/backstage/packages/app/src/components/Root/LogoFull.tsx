import React from 'react';
import { makeStyles } from '@material-ui/core';

const useStyles = makeStyles({
  svg: {
    width: 'auto',
    height: 30,
  },
  text: {
    fill: '#ffffff',
    fontFamily: 'Helvetica Neue, Arial, sans-serif',
    fontWeight: 700,
    fontSize: '24px',
  },
});

const LogoFull = () => {
  const classes = useStyles();

  return (
    <svg
      className={classes.svg}
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 180 40"
    >
      <text className={classes.text} x="10" y="28">
        Backstage
      </text>
    </svg>
  );
};

export default LogoFull;
