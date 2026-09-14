// @ts-check
import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: ['dist/', 'node_modules/'],
  },
  js.configs.recommended,
  // Type-checked rules for application source plus the root-level *.config.ts files
  // (vite.config.ts) - mirrors backend/eslint.config.js's split between type-checked src and
  // plain-JS config files.
  {
    files: ['src/**/*.{ts,tsx}'],
    extends: [
      ...tseslint.configs.recommendedTypeChecked,
      // eslint-plugin-react-hooks's top-level `configs['recommended-latest']` is still in the
      // legacy eslintrc shape (`plugins: ["react-hooks"]`, a string array) - `configs.flat.*` is
      // the actual flat-config-compatible export (confirmed by inspecting the installed package,
      // not assumed from its docs).
      reactHooks.configs.flat['recommended-latest'],
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['*.config.ts'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  // eslint.config.js itself isn't part of any tsconfig project, so lint it without type
  // information rather than fighting the project service over it.
  {
    files: ['*.config.js'],
    extends: [...tseslint.configs.recommended],
  },
  eslintConfigPrettier,
);
