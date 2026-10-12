// amazon-cognito-identity-js pulls in `buffer`, which expects Node's `global`. Vite's `define`
// doesn't reach the Rolldown pre-bundler, so shim it at runtime instead.
//
// Must be the first import in main.tsx.
if (typeof window !== 'undefined' && !('global' in window)) {
  (window as unknown as { global: typeof window }).global = window;
}

export {};
