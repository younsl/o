/// <reference types="vite/client" />

declare const __REACT_VERSION__: string
declare const __TYPESCRIPT_VERSION__: string
declare const __VITE_VERSION__: string
declare const __NODE_VERSION__: string

declare module '*.module.css' {
  const classes: { readonly [key: string]: string }
  export default classes
}

declare module 'cytoscape-fcose' {
  const ext: cytoscape.Ext
  export default ext
}
