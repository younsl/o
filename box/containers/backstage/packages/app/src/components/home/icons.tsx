import React from 'react';
import { siArgo, siKubernetes } from 'simple-icons';

const SvgIconBase = ({ d, title, style }: { d: string | string[]; title?: string; style?: React.CSSProperties }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="currentColor"
    width="1em"
    height="1em"
    style={{ fontSize: 'inherit', ...style }}
    aria-hidden={!title}
    role={title ? 'img' : undefined}
  >
    {title && <title>{title}</title>}
    {Array.isArray(d) ? d.map((p, i) => <path key={i} d={p} />) : <path d={d} />}
  </svg>
);

export const KubernetesIcon = ({ style }: { style?: React.CSSProperties }) => (
  <SvgIconBase d={siKubernetes.path} title={siKubernetes.title} style={style} />
);

export const ArgocdIcon = ({ style }: { style?: React.CSSProperties }) => (
  <SvgIconBase d={siArgo.path} title={siArgo.title} style={style} />
);

export const CategoryIcon = ({ style }: { style?: React.CSSProperties }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="currentColor"
    width="1em"
    height="1em"
    style={{ fontSize: 'inherit', ...style }}
    role="img"
  >
    <title>Category</title>
    <path d="M12 2l-5.5 9h11z" />
    <circle cx="17.5" cy="17.5" r="4.5" />
    <path d="M3 13.5h8v8H3z" />
  </svg>
);

export const ExtensionIcon = ({ style }: { style?: React.CSSProperties }) => (
  <SvgIconBase d="M20.5 11H19V7c0-1.1-.9-2-2-2h-4V3.5C13 2.12 11.88 1 10.5 1S8 2.12 8 3.5V5H4c-1.1 0-1.99.9-1.99 2v3.8H3.5c1.49 0 2.7 1.21 2.7 2.7s-1.21 2.7-2.7 2.7H2V20c0 1.1.9 2 2 2h3.8v-1.5c0-1.49 1.21-2.7 2.7-2.7 1.49 0 2.7 1.21 2.7 2.7V22H17c1.1 0 2-.9 2-2v-4h1.5c1.38 0 2.5-1.12 2.5-2.5S21.88 11 20.5 11z" title="Extension" style={style} />
);

export const CloudUploadIcon = ({ style }: { style?: React.CSSProperties }) => (
  <SvgIconBase d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM14 13v4h-4v-4H7l5-5 5 5h-3z" title="Cloud Upload" style={style} />
);

export const SecurityIcon = ({ style }: { style?: React.CSSProperties }) => (
  <SvgIconBase d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm0 10.99h7c-.53 4.12-3.28 7.79-7 8.94V12H5V6.3l7-3.11v8.8z" title="Security" style={style} />
);

export const HealthIcon = ({ style }: { style?: React.CSSProperties }) => (
  <SvgIconBase d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zM9 17H7v-7h2v7zm4 0h-2V7h2v10zm4 0h-2v-4h2v4z" title="Catalog Health" style={style} />
);
