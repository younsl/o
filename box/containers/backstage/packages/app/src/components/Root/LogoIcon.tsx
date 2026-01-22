import React from 'react';
import { makeStyles } from '@material-ui/core';

const useStyles = makeStyles({
  svg: {
    width: 'auto',
    height: 28,
  },
  text: {
    fill: '#7df3e1',
    fontFamily: 'Helvetica Neue, Arial, sans-serif',
    fontWeight: 700,
    fontSize: '24px',
  },
});

const LogoIcon = () => {
  const classes = useStyles();

  return (
    <svg
      className={classes.svg}
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 30 40"
    >
      <text className={classes.text} x="2" y="28">
        B
      </text>
    </svg>
  );
};

export default LogoIcon;
