// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: ['dist/', 'coverage/', 'drizzle/', 'node_modules/'],
  },
  js.configs.recommended,
  // Type-checked rules for everything tsconfig.json covers: application source plus the
  // root-level *.config.ts files (drizzle.config.ts, vitest.config.ts).
  {
    files: ['src/**/*.ts', '*.config.ts'],
    extends: [...tseslint.configs.recommendedTypeChecked],
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
  // This file isn't in tsconfig.json, so lint it without type information.
  {
    files: ['*.config.js'],
    extends: [...tseslint.configs.recommended],
  },
  eslintConfigPrettier,
);
