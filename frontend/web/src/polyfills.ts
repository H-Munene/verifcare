// amazon-cognito-identity-js depends on the `buffer` package, which references Node's `global`
// at module-evaluation time - undefined in a browser, so the whole app failed to render at all
// (a blank screen, with "ReferenceError: global is not defined" in the browser console - found via
// the Vite dev server's own error log, not the browser, since Chrome automation wasn't available).
//
// Vite 8's dependency pre-bundler now runs on Rolldown, not esbuild - the usual `define: { global:
// 'globalThis' }` fix in vite.config.ts's top-level `define` does not reach that separate
// pre-bundling pass (confirmed by inspecting the actual pre-bundled output after trying it: it
// still said `global.TYPED_ARRAY_SUPPORT` literally), and Rolldown's own equivalent
// (`optimizeDeps.rolldownOptions.transform.define`) is internal, version-fragile API surface for a
// still-very-new engine. A runtime shim is simpler and independent of any bundler-internal option:
// assigning `window.global` makes the bare identifier `global` resolve for every script that runs
// afterward in this realm, exactly like the Node global it's standing in for.
//
// Must be the very first import in main.tsx, before anything that might transitively import
// amazon-cognito-identity-js.
if (typeof window !== 'undefined' && !('global' in window)) {
  (window as unknown as { global: typeof window }).global = window;
}

export {};
