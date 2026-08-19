// apps/api/src/infrastructure/observability/iitm-register-hooks.d.ts

// Ambient declarations for `import-in-the-middle/register-hooks.mjs`.
//
// The package ships types as `register-hooks.d.ts`, but TypeScript pairs a
// `.d.mts` declaration with a `.mjs` source, so the subpath import has no
// automatically-resolved types. This module mirrors the upstream signatures
// (see the package's `register-hooks.d.ts`). Keep in sync when upgrading
// `import-in-the-middle`.

declare module "import-in-the-middle/register-hooks.mjs" {
  export type RegisterHooksOptions = {
    include?: Array<string | RegExp>;
    exclude?: Array<string | RegExp>;
  };

  /**
   * Registers `import-in-the-middle` as a synchronous, in-thread loader hook
   * via `module.registerHooks()`. Throws if the running Node version does not
   * support synchronous hooks.
   */
  export function register(options?: RegisterHooksOptions): void;

  /**
   * Whether the running Node version supports the synchronous loader hooks that
   * `register()` installs.
   */
  export function supportsSyncHooks(): boolean;
}
