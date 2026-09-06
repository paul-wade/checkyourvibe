/**
 * @file packages/core/src/dashboard/styles.ts
 * Self-contained CSS stylesheet for the dashboard board.
 *
 * The design tokens and utility classes are derived from the checked-in
 * dashboard HTML templates. All colours are custom properties; all literal
 * colours live inside this one stylesheet so every other dashboard stylesheet
 * can reference them with `var(--cyv-*)`.
 */

export function dashboardCss(): string {
  const colorTokens: Record<string, string> = {
    'inverse-surface': '#e3e2e6',
    'primary-container': '#947dff',
    'inverse-on-surface': '#303034',
    surface: '#121316',
    'primary-fixed-dim': '#cabeff',
    'primary-fixed': '#e6deff',
    'on-secondary-fixed-variant': '#005236',
    secondary: '#4edea3',
    'on-primary': '#32009a',
    'error-container': '#93000a',
    'on-tertiary-fixed-variant': '#653e00',
    'tertiary-fixed-dim': '#ffb95f',
    'secondary-fixed-dim': '#4edea3',
    'on-primary-fixed': '#1c0062',
    'on-error-container': '#ffdad6',
    'surface-tint': '#cabeff',
    error: '#ffb4ab',
    'surface-container': '#1f1f23',
    tertiary: '#ffb95f',
    'surface-variant': '#343538',
    'tertiary-fixed': '#ffddb8',
    'surface-container-lowest': '#0d0e11',
    'on-tertiary-fixed': '#2a1700',
    'tertiary-container': '#ca8100',
    'on-background': '#e3e2e6',
    'on-tertiary': '#472a00',
    'on-primary-container': '#2b0088',
    'surface-container-low': '#1b1b1f',
    'on-error': '#690005',
    'secondary-container': '#00a572',
    'surface-dim': '#121316',
    'on-secondary-container': '#00311f',
    'on-secondary-fixed': '#002113',
    'on-surface': '#e3e2e6',
    'surface-container-high': '#292a2d',
    'secondary-fixed': '#6ffbbe',
    outline: '#938ea1',
    'surface-container-highest': '#343538',
    'on-secondary': '#003824',
    'on-primary-fixed-variant': '#4918c8',
    'on-surface-variant': '#c9c4d8',
    'on-tertiary-container': '#3e2400',
    'surface-bright': '#38393c',
    'outline-variant': '#484555',
    background: '#121316',
    primary: '#cabeff',
    'inverse-primary': '#613de0',
    // Compatibility aliases used by other dashboard stylesheets.
    bg: '#0d0e11',
    'surface-low': '#1b1b1f',
    'surface-high': '#292a2d',
    'surface-highest': '#343538',
  };

  const spacingTokens: Record<string, string> = {
    'space-xxs': '0.125rem',
    'space-xs': '0.25rem',
    'space-sm': '0.5rem',
    'space-md': '0.75rem',
    'space-lg': '1rem',
    'space-xl': '1.25rem',
    'space-xxl': '1.5rem',
    'space-xxxl': '2rem',
    'gutter-mobile': '1rem',
    'gutter-desktop': '2rem',
    'touch-target-min': '2.75rem',
  };

  const radiusTokens: Record<string, string> = {
    radius: '0.125rem',
    'radius-lg': '0.25rem',
    'radius-xl': '0.5rem',
    'radius-full': '9999px',
  };

  const fontTokens: Record<string, string> = {
    'font-sans': 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    'font-mono': 'ui-monospace, Consolas, Monaco, "Liberation Mono", monospace',
    'font-headline': 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  };

  const shadowTokens: Record<string, string> = {
    'shadow-sm': '0 1px 2px 0 rgba(0, 0, 0, 0.3)',
    'shadow-md': '0 4px 6px -1px rgba(0, 0, 0, 0.3)',
  };

  const alphaTokens: Record<string, string> = {
    'secondary-soft': 'color-mix(in srgb, var(--cyv-secondary) 15%, transparent)',
    'tertiary-soft': 'color-mix(in srgb, var(--cyv-tertiary) 15%, transparent)',
    'error-soft': 'color-mix(in srgb, var(--cyv-error) 15%, transparent)',
    'primary-soft': 'color-mix(in srgb, var(--cyv-primary) 15%, transparent)',
    'surface-glass': 'color-mix(in srgb, var(--cyv-surface) 85%, transparent)',
    'surface-soft': 'color-mix(in srgb, var(--cyv-surface) 60%, transparent)',
    'surface-container-low-soft': 'color-mix(in srgb, var(--cyv-surface-container-low) 60%, transparent)',
    'secondary-bg': 'color-mix(in srgb, var(--cyv-secondary) 15%, transparent)',
    'tertiary-bg': 'color-mix(in srgb, var(--cyv-tertiary) 15%, transparent)',
    'error-bg': 'color-mix(in srgb, var(--cyv-error) 15%, transparent)',
    'secondary-dim': 'color-mix(in srgb, var(--cyv-secondary) 60%, transparent)',
    'tertiary-dim': 'color-mix(in srgb, var(--cyv-tertiary) 60%, transparent)',
    'error-dim': 'color-mix(in srgb, var(--cyv-error) 60%, transparent)',
    'on-surface-dim': 'color-mix(in srgb, var(--cyv-on-surface) 60%, transparent)',
  };

  const allTokens: Record<string, string> = {
    ...colorTokens,
    ...spacingTokens,
    ...radiusTokens,
    ...fontTokens,
    ...shadowTokens,
    ...alphaTokens,
  };

  const rootBlock = Object.entries(allTokens)
    .map(([name, value]) => `  --cyv-${name}: ${value};`)
    .join('\n');

  const colorNames = Object.keys(colorTokens);
  const bgColorClasses = colorNames
    .map((name) => `.bg-${name} { background-color: var(--cyv-${name}); }`)
    .join('\n');
  const textColorClasses = colorNames
    .map((name) => `.text-${name} { color: var(--cyv-${name}); }`)
    .join('\n');

  const alphaNames = Object.keys(alphaTokens);
  const alphaColorClasses = alphaNames
    .map((name) => `.bg-${name} { background-color: var(--cyv-${name}); }`)
    .join('\n');

  const textAlphaClasses = `
.text-secondary-dim { color: var(--cyv-secondary-dim); }
.text-tertiary-dim { color: var(--cyv-tertiary-dim); }
.text-error-dim { color: var(--cyv-error-dim); }
.text-on-surface-dim { color: var(--cyv-on-surface-dim); }
`;

  const spaceSizes = [
    { cssName: '2xs', token: 'xxs' },
    { cssName: 'xs', token: 'xs' },
    { cssName: 'sm', token: 'sm' },
    { cssName: 'md', token: 'md' },
    { cssName: 'lg', token: 'lg' },
    { cssName: 'xl', token: 'xl' },
    { cssName: '2xl', token: 'xxl' },
    { cssName: '3xl', token: 'xxxl' },
  ];

  const paddingDirections = [
    { prefix: 'p', props: ['padding'] },
    { prefix: 'px', props: ['padding-inline'] },
    { prefix: 'py', props: ['padding-block'] },
    { prefix: 'pt', props: ['padding-top'] },
    { prefix: 'pr', props: ['padding-right'] },
    { prefix: 'pb', props: ['padding-bottom'] },
    { prefix: 'pl', props: ['padding-left'] },
  ];

  const marginDirections = [
    { prefix: 'm', props: ['margin'] },
    { prefix: 'mx', props: ['margin-inline'] },
    { prefix: 'my', props: ['margin-block'] },
    { prefix: 'mt', props: ['margin-top'] },
    { prefix: 'mr', props: ['margin-right'] },
    { prefix: 'mb', props: ['margin-bottom'] },
    { prefix: 'ml', props: ['margin-left'] },
  ];

  function generateBoxClasses(
    directions: { prefix: string; props: string[] }[],
    sizePrefix: string,
  ): string {
    return spaceSizes
      .flatMap(({ cssName, token }) =>
        directions.map(({ prefix, props }) =>
          props
            .map((prop) => `.${prefix}-${sizePrefix}-${cssName} { ${prop}: var(--cyv-space-${token}); }`)
            .join('\n'),
        ),
      )
      .join('\n');
  }

  const paddingClasses = generateBoxClasses(paddingDirections, 'space');
  const marginClasses = generateBoxClasses(marginDirections, 'space');

  const gapClasses = spaceSizes
    .map(({ cssName, token }) => `.gap-space-${cssName} { gap: var(--cyv-space-${token}); }`)
    .join('\n');

  const gutterClasses = `
.p-gutter-mobile { padding: var(--cyv-gutter-mobile); }
.p-gutter-desktop { padding: var(--cyv-gutter-desktop); }
.px-gutter-mobile { padding-inline: var(--cyv-gutter-mobile); }
.px-gutter-desktop { padding-inline: var(--cyv-gutter-desktop); }
.py-gutter-mobile { padding-block: var(--cyv-gutter-mobile); }
.py-gutter-desktop { padding-block: var(--cyv-gutter-desktop); }
`;

  const radiusClasses = `
.rounded { border-radius: var(--cyv-radius); }
.rounded-lg { border-radius: var(--cyv-radius-lg); }
.rounded-xl { border-radius: var(--cyv-radius-xl); }
.rounded-full { border-radius: var(--cyv-radius-full); }
.rounded-t-xl { border-top-left-radius: var(--cyv-radius-xl); border-top-right-radius: var(--cyv-radius-xl); }
`;

  const shadowClasses = `
.shadow-sm { box-shadow: var(--cyv-shadow-sm); }
.shadow-md { box-shadow: var(--cyv-shadow-md); }
`;

  const fontClasses = `
.font-sans { font-family: var(--cyv-font-sans); }
.font-mono { font-family: var(--cyv-font-mono); }
.font-headline { font-family: var(--cyv-font-headline); }

.font-mono-sm { font-family: var(--cyv-font-mono); font-size: 11px; line-height: 14px; letter-spacing: 0.02em; font-weight: 400; }
.font-mono-md { font-family: var(--cyv-font-mono); font-size: 12px; line-height: 16px; font-weight: 400; }
.font-mono-lg { font-family: var(--cyv-font-mono); font-size: 14px; line-height: 20px; letter-spacing: -0.01em; font-weight: 600; }

.font-label-md { font-family: var(--cyv-font-sans); font-size: 12px; line-height: 16px; letter-spacing: 0.04em; font-weight: 600; text-transform: uppercase; }
.font-label-xs { font-family: var(--cyv-font-mono); font-size: 10px; line-height: 12px; letter-spacing: 0.06em; font-weight: 600; text-transform: uppercase; }

.font-body-sm { font-family: var(--cyv-font-sans); font-size: 12px; line-height: 16px; font-weight: 400; }
.font-body-md { font-family: var(--cyv-font-sans); font-size: 14px; line-height: 20px; font-weight: 400; }

.font-headline-sm { font-family: var(--cyv-font-headline); font-size: 18px; line-height: 24px; letter-spacing: -0.01em; font-weight: 500; }

.font-bold { font-weight: 700; }
.font-semibold { font-weight: 600; }
.font-medium { font-weight: 500; }
.font-normal { font-weight: 400; }

.uppercase { text-transform: uppercase; }
.tracking-tight { letter-spacing: -0.01em; }
.tracking-wider { letter-spacing: 0.04em; }
.tracking-widest { letter-spacing: 0.06em; }
.leading-tight { line-height: 1.25; }
.leading-snug { line-height: 1.375; }
.leading-relaxed { line-height: 1.625; }
.text-left { text-align: left; }
.text-center { text-align: center; }
`;

  const layoutClasses = `
.flex { display: flex; }
.inline-flex { display: inline-flex; }
.flex-col { flex-direction: column; }
.items-center { align-items: center; }
.items-start { align-items: flex-start; }
.items-stretch { align-items: stretch; }
.justify-between { justify-content: space-between; }
.justify-center { justify-content: center; }
.justify-around { justify-content: space-around; }
.justify-end { justify-content: flex-end; }
.shrink-0 { flex-shrink: 0; }
.flex-1 { flex: 1 1 0%; }
.min-w-0 { min-width: 0; }
.w-full { width: 100%; }
.h-full { height: 100%; }
.h-touch-target-min { height: var(--cyv-touch-target-min); }
.min-h-screen { min-height: 100vh; }

.grid { display: grid; }
.grid-cols-1 { grid-template-columns: repeat(1, minmax(0, 1fr)); }
.grid-cols-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.grid-cols-3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.grid-cols-4 { grid-template-columns: repeat(4, minmax(0, 1fr)); }

.truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.line-clamp-1 { overflow: hidden; display: -webkit-box; -webkit-line-clamp: 1; -webkit-box-orient: vertical; }
.line-clamp-2 { overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }

.hidden { display: none; }
`;

  const opacityClasses = `
.opacity-60 { opacity: 0.6; }
.opacity-70 { opacity: 0.7; }
.opacity-75 { opacity: 0.75; }
.opacity-90 { opacity: 0.9; }
`;

  const animation = `
@keyframes cyv-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

@keyframes cyv-ping {
  75%, 100% { transform: scale(2); opacity: 0; }
}

.animate-pulse { animation: cyv-pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite; }
.animate-ping { animation: cyv-ping 1s cubic-bezier(0, 0, 0.2, 1) infinite; }
`;

  // Shared component classes used by other dashboard modules.
  const componentClasses = `
/* Header Navbar */
.cyv-header {
  position: sticky;
  top: 0;
  z-index: 100;
  background-color: rgba(18, 19, 22, 0.95);
  backdrop-filter: blur(12px);
  border-bottom: 1px solid var(--cyv-surface-highest);
  padding: 0.75rem 1.5rem;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
}

.cyv-brand {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  font-family: var(--cyv-font-mono);
  font-weight: 600;
  font-size: 15px;
}

.cyv-brand-logo {
  height: 24px;
  width: auto;
}

.cyv-nav-tabs {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.cyv-tab {
  padding: 0.35rem 0.75rem;
  border-radius: 4px;
  font-size: 13px;
  color: var(--cyv-on-surface-variant);
  transition: all 0.15s ease;
}

.cyv-tab:hover, .cyv-tab.active {
  background-color: var(--cyv-surface-highest);
  color: var(--cyv-on-surface);
}

/* Status Banner */
.cyv-banner {
  background-color: var(--cyv-bg);
  border-bottom: 1px solid var(--cyv-surface-high);
  padding: 0.75rem 1.5rem;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
}

.cyv-banner-badge {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.25rem 0.6rem;
  border-radius: 4px;
  font-family: var(--cyv-font-mono);
  font-size: 12px;
  font-weight: 700;
  background-color: var(--cyv-tertiary-bg);
  color: var(--cyv-tertiary);
}

.cyv-kpi-cluster {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  font-family: var(--cyv-font-mono);
  font-size: 12px;
}

.cyv-kpi-pill {
  background-color: var(--cyv-surface-container);
  padding: 0.25rem 0.6rem;
  border-radius: 4px;
  display: flex;
  align-items: center;
  gap: 0.35rem;
}

/* Layout helpers */
.cyv-container {
  padding: 1.25rem 1.5rem;
  width: 100%;
}

/* Panel Cards */
.cyv-card {
  background-color: var(--cyv-surface-low);
  border: 1px solid var(--cyv-surface-high);
  border-radius: 6px;
  padding: 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.cyv-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--cyv-on-surface);
}

/* Status Badges */
.cyv-badge {
  display: inline-block;
  padding: 0.15rem 0.45rem;
  border-radius: 4px;
  font-family: var(--cyv-font-mono);
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
}

.cyv-badge-free {
  background-color: var(--cyv-secondary-bg);
  color: var(--cyv-secondary);
}

.cyv-badge-running {
  background-color: var(--cyv-tertiary-bg);
  color: var(--cyv-tertiary);
}

.cyv-badge-failed {
  background-color: var(--cyv-error-bg);
  color: var(--cyv-error);
}

.cyv-badge-passed {
  background-color: var(--cyv-secondary-bg);
  color: var(--cyv-secondary);
}

/* Buttons */
.cyv-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.35rem;
  padding: 0.4rem 0.8rem;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 600;
  border: none;
  cursor: pointer;
  transition: background-color 0.15s ease;
  text-decoration: none;
}

.cyv-btn-primary {
  background-color: var(--cyv-primary);
  color: var(--cyv-on-primary);
}
.cyv-btn-primary:hover {
  background-color: var(--cyv-primary-container);
}

.cyv-btn-secondary {
  background-color: var(--cyv-surface-container);
  color: var(--cyv-on-surface);
}
.cyv-btn-secondary:hover {
  background-color: var(--cyv-surface-highest);
}

/* Code & Diff Snippets */
pre, code {
  font-family: var(--cyv-font-mono);
}

.cyv-code-block {
  background-color: var(--cyv-bg);
  border: 1px solid var(--cyv-surface-highest);
  border-radius: 4px;
  padding: 0.75rem;
  font-size: 12px;
  overflow-x: auto;
}

.cyv-diff-add {
  color: var(--cyv-secondary);
}
.cyv-diff-remove {
  color: var(--cyv-error);
}
`;

  return `
:root {
${rootBlock}
}

* {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

html {
  -webkit-text-size-adjust: 100%;
}

body {
  background-color: var(--cyv-surface);
  color: var(--cyv-on-surface);
  font-family: var(--cyv-font-sans);
  font-size: 14px;
  line-height: 1.5;
  min-height: 100vh;
}

::selection {
  background-color: var(--cyv-primary-container);
  color: var(--cyv-on-primary-container);
}

a {
  color: var(--cyv-primary);
  text-decoration: none;
}

a:hover {
  text-decoration: underline;
}

pre, code {
  font-family: var(--cyv-font-mono);
}

${bgColorClasses}
${textColorClasses}
${alphaColorClasses}
${textAlphaClasses}
${paddingClasses}
${marginClasses}
${gapClasses}
${gutterClasses}
${radiusClasses}
${shadowClasses}
${fontClasses}
${layoutClasses}
${opacityClasses}
${animation}

${componentClasses}
`;
}

/**
 * Stylesheet for the /specs editor page. Phone-first: the file list collapses
 * once a file is open, the textarea fills the viewport, and the save control
 * sits in a fixed bottom bar within thumb reach.
 */
export function specPageCss(): string {
  return `
.specs-body { display: flex; flex-direction: column; min-height: 100vh; }
.specs-layout { display: flex; flex: 1 1 auto; min-height: 0; }
.specs-list { width: 100%; max-width: 360px; border-right: 1px solid var(--cyv-surface-highest); overflow-y: auto; padding: var(--cyv-space-md); background: var(--cyv-surface); }
.specs-list-header { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: var(--cyv-space-lg); }
.specs-list-header h1 { font-size: 1.25rem; font-weight: 600; }
.specs-count { color: var(--cyv-on-surface-variant); font-family: var(--cyv-font-mono); font-size: 0.875rem; }
.specs-empty { color: var(--cyv-on-surface-variant); font-size: 0.875rem; }
.specs-error { color: var(--cyv-error); font-family: var(--cyv-font-mono); font-size: 0.875rem; margin-bottom: var(--cyv-space-md); }
.specs-dir { margin-bottom: var(--cyv-space-lg); }
.specs-dir h2 { font-size: 0.875rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--cyv-on-surface-variant); margin-bottom: var(--cyv-space-sm); }
.specs-dir ul { list-style: none; padding: 0; margin: 0; }
.specs-dir li { border-top: 1px solid var(--cyv-surface-highest); }
.specs-dir li:first-child { border-top: none; }
.specs-file { display: block; padding: var(--cyv-space-sm) 0; color: var(--cyv-on-surface); text-decoration: none; font-family: var(--cyv-font-mono); font-size: 0.875rem; }
.specs-file:hover { color: var(--cyv-primary); }
.specs-editor { flex: 1 1 auto; display: flex; flex-direction: column; min-width: 0; background: var(--cyv-surface); position: relative; }
.specs-file-bar { display: flex; align-items: center; justify-content: space-between; gap: var(--cyv-space-sm); padding: var(--cyv-space-sm) var(--cyv-space-md); border-bottom: 1px solid var(--cyv-surface-highest); background: var(--cyv-surface-container-low); }
.specs-file-path { font-family: var(--cyv-font-mono); font-size: 0.875rem; color: var(--cyv-on-surface); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.specs-file-actions { display: flex; gap: var(--cyv-space-sm); align-items: center; }
.specs-readonly-badge { font-family: var(--cyv-font-mono); font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--cyv-tertiary); border: 1px solid var(--cyv-tertiary); padding: 0.2rem 0.4rem; border-radius: var(--cyv-radius); }
button.specs-preview-toggle,
button.specs-close,
button.specs-save { font-family: var(--cyv-font-mono); font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--cyv-on-surface); background: var(--cyv-surface-container); border: 1px solid var(--cyv-surface-highest); border-radius: var(--cyv-radius); padding: 0.45rem 0.75rem; cursor: pointer; min-height: var(--cyv-touch-target-min); }
button.specs-save { background: var(--cyv-primary); color: var(--cyv-on-primary); border-color: var(--cyv-primary); font-weight: 600; min-width: 4.5rem; }
button.specs-save:disabled { opacity: 0.5; }
.specs-editor-panes { flex: 1 1 auto; position: relative; min-height: 0; display: flex; }
.specs-source,
.specs-preview { position: absolute; inset: 0; width: 100%; height: 100%; box-sizing: border-box; }
.specs-source { border: none; resize: none; padding: var(--cyv-space-md); font-family: var(--cyv-font-mono); font-size: 14px; line-height: 1.6; background: var(--cyv-surface); color: var(--cyv-on-surface); }
.specs-source:focus { outline: 2px solid var(--cyv-primary); outline-offset: -2px; }
.specs-preview { overflow-y: auto; padding: var(--cyv-space-md); background: var(--cyv-surface); color: var(--cyv-on-surface); }
.specs-preview[hidden] { display: none; }
.specs-fab { position: fixed; left: 0; right: 0; bottom: 0; z-index: 50; display: flex; align-items: center; justify-content: space-between; gap: var(--cyv-space-sm); padding: var(--cyv-space-sm) var(--cyv-space-md); background: var(--cyv-surface-container-low); border-top: 1px solid var(--cyv-surface-highest); }
.specs-err { color: var(--cyv-error); font-family: var(--cyv-font-mono); font-size: 0.875rem; }
.specs-locked-notice { padding: var(--cyv-space-md); color: var(--cyv-tertiary); background: var(--cyv-tertiary-bg); border-bottom: 1px solid var(--cyv-surface-highest); }
.specs-locked-notice strong { color: var(--cyv-tertiary); }
.specs-preview h1,
.specs-preview h2,
.specs-preview h3,
.specs-preview h4 { margin: 0 0 var(--cyv-space-sm); font-weight: 600; }
.specs-preview h1 { font-size: 1.25rem; }
.specs-preview h2 { font-size: 1.1rem; }
.specs-preview h3 { font-size: 1rem; }
.specs-preview p { margin: 0 0 var(--cyv-space-sm); line-height: 1.6; }
.specs-preview ul,
.specs-preview ol { margin: 0 0 var(--cyv-space-sm); padding-left: 1.25rem; }
.specs-preview li { margin-bottom: var(--cyv-space-xs); }
.specs-preview code { font-family: var(--cyv-font-mono); background: var(--cyv-surface-container); padding: 0.1rem 0.3rem; border-radius: var(--cyv-radius); }
.specs-preview pre { background: var(--cyv-surface-container); padding: var(--cyv-space-sm); border-radius: var(--cyv-radius); overflow-x: auto; }
.specs-preview pre code { background: transparent; padding: 0; }
.specs-preview a { color: var(--cyv-primary); text-decoration: underline; }

.board-session-list {
  display: flex;
  flex-direction: column;
  gap: var(--cyv-space-sm);
}
.board-session-row {
  background-color: var(--cyv-surface-container);
  border: 1px solid var(--cyv-surface-container-high);
  border-radius: var(--cyv-radius);
  padding: var(--cyv-space-sm);
  display: flex;
  flex-direction: column;
  gap: var(--cyv-space-xs);
}
.board-session-head,
.board-session-meta {
  display: flex;
  align-items: center;
  gap: var(--cyv-space-xs);
  flex-wrap: wrap;
}
.board-session-head {
  justify-content: space-between;
}
.board-session-meta {
  color: var(--cyv-on-surface-variant);
}
.board-session-stop {
  align-self: flex-start;
}
.board-session-start {
  display: flex;
  flex-direction: column;
  gap: var(--cyv-space-xs);
}
.board-session-select {
  width: 100%;
}
.board-session-start-btn {
  width: 100%;
}
.board-session-error {
  color: var(--cyv-error);
  margin: 0;
}

@media (max-width: 640px) {
  .specs-layout { flex-direction: column; }
  .specs-list { max-width: none; border-right: none; border-bottom: 1px solid var(--cyv-surface-highest); }
  .specs-layout[data-open="true"] .specs-list { display: none; }
  .specs-layout[data-open="true"] .specs-editor { position: fixed; inset: 56px 0 56px 0; z-index: 10; }
}

@media (min-width: 641px) {
  .specs-layout { flex-direction: row; }
  .specs-list { display: block; }
  .specs-editor { position: static; }
}
`;
}

/**
 * The /tasks page: one scrolling list, a sticky filter bar on top, and the
 * dispatch form pinned to the foot of the page so its confirmation stays
 * under the thumb. Every colour is a token, per the design rule that the
 * dashboard names no literal colour.
 */
export function tasksPageCss(): string {
  return `
.tk-body { background: var(--cyv-surface); color: var(--cyv-on-surface); }
.tk-main { max-width: 44rem; margin: 0 auto; padding: 0 var(--cyv-gutter-mobile) var(--cyv-space-xxl); }
.tk-filter { position: sticky; top: 0; z-index: 5; display: flex; gap: var(--cyv-space-sm); align-items: center; padding: var(--cyv-space-sm) 0; background: var(--cyv-surface); }
.tk-filter select { flex: 1 1 0; min-width: 0; min-height: var(--cyv-touch-target-min); padding: 0 var(--cyv-space-sm); border: 1px solid var(--cyv-surface-highest); border-radius: var(--cyv-radius); background: var(--cyv-surface-container); color: var(--cyv-on-surface); font: inherit; }
.tk-filter-btn { flex: none; min-height: var(--cyv-touch-target-min); padding: 0 var(--cyv-space-md); border: 1px solid var(--cyv-surface-highest); border-radius: var(--cyv-radius); background: var(--cyv-surface-container); color: var(--cyv-on-surface); font: inherit; }
.tk-spec { border-top: 1px solid var(--cyv-surface-highest); padding: var(--cyv-space-md) 0; }
.tk-spec-head { display: flex; align-items: baseline; gap: var(--cyv-space-sm); }
.tk-spec-head h2 { flex: 1; min-width: 0; margin: 0; font-size: 1rem; font-weight: 600; }
.tk-count { color: var(--cyv-on-surface-variant); font-size: 0.8rem; flex: none; }
.tk-file { color: var(--cyv-primary); font-size: 0.8rem; flex: none; text-decoration: none; }
.tk-group h3 { margin: var(--cyv-space-md) 0 var(--cyv-space-xs); font-family: var(--cyv-font-mono); font-size: 0.72rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: var(--cyv-on-surface-variant); }
.tk-task { padding: var(--cyv-space-sm) 0 var(--cyv-space-sm); border-top: 1px solid var(--cyv-surface-highest); }
.tk-group .tk-task:first-of-type { border-top: none; }
.tk-head { display: flex; align-items: baseline; gap: var(--cyv-space-sm); }
.tk-id { color: var(--cyv-primary); flex: none; }
.tk-title { flex: 1; min-width: 0; }
.tk-task[data-state='done'] .tk-title { color: var(--cyv-on-surface-variant); }
.tk-st { flex: none; font-family: var(--cyv-font-mono); font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.05em; padding: 0.15rem 0.45rem; border-radius: var(--cyv-radius); }
.tk-st-never { background: var(--cyv-surface-container); color: var(--cyv-on-surface-variant); }
.tk-st-in-motion { background: var(--cyv-tertiary-bg); color: var(--cyv-tertiary); }
.tk-st-succeeded { background: var(--cyv-secondary-bg); color: var(--cyv-secondary); }
.tk-st-failed { background: var(--cyv-error-bg); color: var(--cyv-error); }
.tk-st-done { background: var(--cyv-surface-container); color: var(--cyv-on-surface-variant); }
.tk-meta { margin-top: 2px; font-size: 0.8rem; color: var(--cyv-on-surface-variant); display: flex; gap: var(--cyv-space-sm); flex-wrap: wrap; }
.tk-files { display: block; margin-top: 2px; font-size: 0.74rem; color: var(--cyv-on-surface-variant); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tk-acts { margin-top: var(--cyv-space-sm); display: flex; align-items: center; gap: var(--cyv-space-md); flex-wrap: wrap; }
.tk-go { display: inline-flex; align-items: center; min-height: var(--cyv-touch-target-min); padding: 0 var(--cyv-space-lg); border: 1px solid var(--cyv-primary); border-radius: var(--cyv-radius); color: var(--cyv-primary); font-weight: 600; text-decoration: none; }
.tk-link { color: var(--cyv-primary); display: inline-flex; align-items: center; min-height: var(--cyv-touch-target-min); }
.tk-note { font-size: 0.8rem; color: var(--cyv-on-surface-variant); }
.tk-empty { color: var(--cyv-on-surface-variant); font-size: 0.9rem; }
.tk-dispatch { margin: var(--cyv-space-lg) calc(var(--cyv-gutter-mobile) * -1) 0; padding: var(--cyv-space-md) var(--cyv-gutter-mobile); border-top: 2px solid var(--cyv-primary); background: var(--cyv-surface); scroll-margin-top: 4.5rem; }
.tk-dispatch h2 { margin: 0 0 var(--cyv-space-xs); font-size: 1.05rem; }
.tk-lede { margin: 0 0 var(--cyv-space-sm); color: var(--cyv-on-surface-variant); }
.tk-form { display: flex; flex-direction: column; gap: var(--cyv-space-sm); margin-top: var(--cyv-space-sm); }
.tk-field { display: flex; flex-direction: column; gap: var(--cyv-space-xs); font-size: 0.8rem; color: var(--cyv-on-surface-variant); }
.tk-field textarea, .tk-field select { min-height: var(--cyv-touch-target-min); padding: var(--cyv-space-sm); border: 1px solid var(--cyv-surface-highest); border-radius: var(--cyv-radius); background: var(--cyv-surface-container); color: var(--cyv-on-surface); font: inherit; }
.tk-field textarea { font-family: var(--cyv-font-mono); font-size: 0.85rem; resize: vertical; }
.tk-sendbar { position: sticky; bottom: 0; margin: 0 calc(var(--cyv-gutter-mobile) * -1); padding: var(--cyv-space-sm) var(--cyv-gutter-mobile) calc(var(--cyv-space-sm) + env(safe-area-inset-bottom)); background: var(--cyv-surface); }
.tk-send { width: 100%; min-height: var(--cyv-touch-target-min); border: none; border-radius: var(--cyv-radius); background: var(--cyv-primary); color: var(--cyv-on-primary); font: inherit; font-weight: 600; }
`;
}

/**
 * The /lanes page (spec 0051 Requirements 2 and 6). Read-only: one stacked
 * section per lane, so a phone reads top to bottom with nothing off the side.
 * Statuses carry the badge colour and nothing else, so the same fact is never
 * shown twice.
 */
export function lanesPageCss(): string {
  return `
.ln-body { background: var(--cyv-surface); color: var(--cyv-on-surface); }
.ln-main { max-width: 46rem; margin: 0 auto; padding: 0 var(--cyv-gutter-mobile) var(--cyv-space-xxl); }
.ln-lede { margin: var(--cyv-space-md) 0; color: var(--cyv-on-surface-variant); font-size: 0.9rem; }
.ln-lane { border-top: 1px solid var(--cyv-surface-highest); padding: var(--cyv-space-md) 0; }
.ln-head { display: flex; align-items: baseline; gap: var(--cyv-space-sm); flex-wrap: wrap; }
.ln-id { font-family: var(--cyv-font-mono); font-weight: 600; font-size: 0.95rem; overflow-wrap: anywhere; }
.ln-badge { font-family: var(--cyv-font-mono); font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.05em; padding: 0.15rem 0.45rem; border-radius: var(--cyv-radius); }
.ln-st-unavailable, .ln-st-exhausted { background: var(--cyv-error-bg); color: var(--cyv-error); }
.ln-st-cooling, .ln-st-capped { background: var(--cyv-tertiary-bg); color: var(--cyv-tertiary); }
.ln-st-running, .ln-st-free { background: var(--cyv-secondary-bg); color: var(--cyv-secondary); }
.ln-st-reserved { background: var(--cyv-surface-container); color: var(--cyv-on-surface-variant); }
.ln-tag { font-family: var(--cyv-font-mono); font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--cyv-on-surface-variant); }
.ln-line { margin: 2px 0; font-size: 0.85rem; overflow-wrap: anywhere; }
.ln-mono { font-family: var(--cyv-font-mono); font-size: 0.85em; overflow-wrap: anywhere; }
.ln-mut { color: var(--cyv-on-surface-variant); }
.ln-bad { color: var(--cyv-error); }
.ln-block { margin-top: var(--cyv-space-sm); }
.ln-block h3, .ln-h2 { margin: 0 0 var(--cyv-space-xs); font-family: var(--cyv-font-mono); font-size: 0.72rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: var(--cyv-on-surface-variant); }
.ln-kind { margin-top: var(--cyv-space-xs); }
.ln-kind-name { font-family: var(--cyv-font-mono); font-size: 0.78rem; color: var(--cyv-on-surface); }
.ln-models { margin: 2px 0 0; padding-left: 1.4rem; font-family: var(--cyv-font-mono); font-size: 0.8rem; }
.ln-models li { margin: 1px 0; overflow-wrap: anywhere; }
.ln-models .ln-start { color: var(--cyv-secondary); }
.ln-dispatches { list-style: none; margin: 0; padding: 0; }
.ln-dispatch { padding: var(--cyv-space-xs) 0; border-top: 1px solid var(--cyv-surface-highest); font-size: 0.82rem; }
.ln-dispatch:first-child { border-top: none; }
.ln-dtask { display: block; overflow-wrap: anywhere; }
.ln-dmeta { display: block; margin-top: 1px; color: var(--cyv-on-surface-variant); font-size: 0.76rem; overflow-wrap: anywhere; }
.ln-outcome { font-family: var(--cyv-font-mono); font-size: 0.72rem; }
.ln-o-succeeded { color: var(--cyv-secondary); }
.ln-o-produced-nothing, .ln-o-rate-limited, .ln-o-out-of-scope-write, .ln-o-changed-files-unexpectedly, .ln-o-did-not-complete, .ln-o-failed { color: var(--cyv-error); }
.ln-o-gates-failed { color: var(--cyv-tertiary); }
.ln-note { margin: 2px 0; font-size: 0.8rem; color: var(--cyv-on-surface-variant); }
.ln-empty { color: var(--cyv-on-surface-variant); font-size: 0.9rem; }
.ln-foot { margin-top: var(--cyv-space-lg); font-family: var(--cyv-font-mono); font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--cyv-on-surface-variant); }
`;
}

/**
 * The Glance page at `/`: one column of full-width tiles a phone reads top to
 * bottom, each a link to the surface where its answer becomes an action. The
 * `.gl-stale` line inside every tile is revealed by the shared live badge's
 * `data-live` state — a dead stream marks every number stale rather than
 * leaving them reading as current. Every colour is a token.
 */
export function glancePageCss(): string {
  return `
.gl-body { background: var(--cyv-surface); color: var(--cyv-on-surface); }
.gl-main { max-width: 40rem; margin: 0 auto; padding: 0 var(--cyv-gutter-mobile) var(--cyv-space-xxl); display: flex; flex-direction: column; gap: var(--cyv-space-sm); }
.gl-status { padding: var(--cyv-space-sm) 0 var(--cyv-space-xs); }
.gl-status-row { display: flex; align-items: center; gap: var(--cyv-space-sm); flex-wrap: wrap; }
.gl-live .board-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; flex: none; }
.gl-live { display: inline-flex; align-items: center; gap: var(--cyv-space-xs); padding: 0.2rem var(--cyv-space-sm); border-radius: var(--cyv-radius); background: var(--cyv-surface-container-high); }
.gl-live[data-live="connected"] .board-live-label { color: var(--cyv-secondary); }
.gl-live[data-live="disconnected"] { border: 1px solid var(--cyv-error); }
.gl-live[data-live="reconnecting"] { border: 1px solid var(--cyv-tertiary); }
.gl-chip { display: inline-flex; align-items: center; min-height: 1.6rem; padding: 0 var(--cyv-space-sm); border-radius: var(--cyv-radius); background: var(--cyv-surface-container-high); color: var(--cyv-on-surface-variant); font-family: var(--cyv-font-mono); font-size: 0.72rem; text-decoration: none; }
.gl-chip-ok { color: var(--cyv-secondary); }
.gl-chip-warn { color: var(--cyv-tertiary); }
.gl-vibe { margin: var(--cyv-space-xs) 0 0; font-size: 0.85rem; color: var(--cyv-on-surface-variant); }
.gl-vibe-stalled { color: var(--cyv-tertiary); }
.gl-vibe-mut { color: var(--cyv-on-surface-variant); }
.gl-tile { display: block; text-decoration: none; color: inherit; background: var(--cyv-surface-container); border: 1px solid var(--cyv-surface-container-high); border-radius: var(--cyv-radius); padding: var(--cyv-space-md); }
.gl-tile:focus-visible { outline: 2px solid var(--cyv-primary); outline-offset: 2px; }
.gl-tile-attn { border-color: var(--cyv-tertiary); }
.gl-tile-head { display: flex; align-items: baseline; justify-content: space-between; gap: var(--cyv-space-sm); }
.gl-name { font-family: var(--cyv-font-mono); font-size: 0.72rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: var(--cyv-on-surface-variant); }
.gl-num { font-size: 1.5rem; font-weight: 700; line-height: 1; }
.gl-say { display: block; margin-top: 2px; font-size: 0.95rem; }
.gl-more { display: block; margin-top: var(--cyv-space-xs); font-size: 0.8rem; color: var(--cyv-on-surface-variant); }
.gl-item { display: block; padding: 1px 0; overflow-wrap: anywhere; }
.gl-item-bad { color: var(--cyv-error); }
.gl-stale { display: none; margin-top: var(--cyv-space-xs); font-family: var(--cyv-font-mono); font-size: 0.72rem; color: var(--cyv-tertiary); }
body:has(.board-live-badge[data-live="disconnected"]) .gl-stale,
body:has(.board-live-badge[data-live="reconnecting"]) .gl-stale { display: block; }
.gl-act { display: block; margin-top: var(--cyv-space-sm); font-size: 0.8rem; color: var(--cyv-primary); }
.gl-projects { display: flex; flex-wrap: wrap; gap: var(--cyv-space-xs); margin-top: var(--cyv-space-md); }
.gl-proj { padding: var(--cyv-space-xs) var(--cyv-space-sm); border: 1px solid var(--cyv-surface-highest); border-radius: var(--cyv-radius); color: var(--cyv-primary); font-size: 0.8rem; text-decoration: none; }
.gl-proj-on { color: var(--cyv-on-surface-variant); border-color: var(--cyv-surface-container-high); }
`;
}
