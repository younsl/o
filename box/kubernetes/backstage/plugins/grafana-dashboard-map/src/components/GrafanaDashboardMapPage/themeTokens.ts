import React from 'react';

/**
 * Resolves a `--bui-*` CSS variable to a concrete CSS color/value string by
 * applying it as an inline `color` on a throw-away element and reading the
 * resolved computed value back. Plain `getPropertyValue` may return the raw
 * `var(...)` reference for custom properties on some browsers, which is not
 * usable when passed to ReactFlow as a JS string.
 */
export function getCssVar(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback;
  const probe = document.createElement('span');
  probe.style.color = `var(${name}, ${fallback})`;
  probe.style.display = 'none';
  document.body.appendChild(probe);
  const resolved = getComputedStyle(probe).color;
  document.body.removeChild(probe);
  return resolved || fallback;
}

/**
 * Resolves a frequently used set of `@backstage/ui` design tokens to actual
 * color strings for places (e.g. ReactFlow edge styles) where a CSS variable
 * cannot be passed directly.
 */
export function useThemeTokens() {
  return React.useMemo(
    () => ({
      fgPrimary: getCssVar('--bui-fg-primary', '#ffffff'),
      fgSecondary: getCssVar('--bui-fg-secondary', '#bdbdbd'),
      fgDisabled: getCssVar('--bui-fg-disabled', '#777777'),
      fgSolid: getCssVar('--bui-fg-solid', '#0070f3'),
      bgApp: getCssVar('--bui-bg-app', '#000000'),
      bgNeutral1: getCssVar('--bui-bg-neutral-1', '#1a1a1a'),
      border1: getCssVar('--bui-border-1', '#333333'),
    }),
    [],
  );
}
