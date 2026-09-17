// Flat ESLint config. No plugins, so it runs with a bare global `eslint`:
//   npx eslint .   (or: eslint . with a global install)

const browserGlobals = {
  window: 'readonly', document: 'readonly', navigator: 'readonly', console: 'readonly',
  localStorage: 'readonly', sessionStorage: 'readonly', indexedDB: 'readonly',
  fetch: 'readonly', Headers: 'readonly', Request: 'readonly', Response: 'readonly',
  URL: 'readonly', URLSearchParams: 'readonly', Blob: 'readonly', FormData: 'readonly',
  AbortController: 'readonly', DOMException: 'readonly', CustomEvent: 'readonly', Event: 'readonly',
  setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly',
  requestAnimationFrame: 'readonly', performance: 'readonly', Intl: 'readonly',
  HTMLElement: 'readonly', Node: 'readonly', structuredClone: 'readonly',
};

const nodeGlobals = {
  process: 'readonly', console: 'readonly', Buffer: 'readonly',
  setTimeout: 'readonly', clearTimeout: 'readonly', URL: 'readonly', fetch: 'readonly',
  // Callbacks handed to Playwright's page.evaluate run in the browser.
  localStorage: 'readonly', document: 'readonly', window: 'readonly',
};

const rules = {
  'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
  'no-undef': 'error',
  'no-console': 'off',
  eqeqeq: ['error', 'smart'],
  'prefer-const': 'error',
  'no-var': 'error',
  'object-shorthand': 'error',
  'no-empty': ['error', { allowEmptyCatch: true }],
};

export default [
  {
    files: ['src/**/*.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: browserGlobals },
    rules,
  },
  {
    files: ['tools/**/*.{js,mjs}', 'eslint.config.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: nodeGlobals },
    rules,
  },
];
