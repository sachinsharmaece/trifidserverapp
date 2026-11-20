import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig([
  globalIgnores(['dist']),

  // Plain JavaScript files in the repo (this config, .husky/install.mjs): basic checks only.
  {
    files: ['**/*.{js,mjs}'],
    extends: [js.configs.recommended],
    languageOptions: { globals: globals.node },
  },

  // The API source: TypeScript rules that use type information, so mistakes such as a forgotten
  // `await` on a promise (no-floating-promises) are caught here instead of in production.
  {
    files: ['**/*.ts'],
    extends: [js.configs.recommended, tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // `_req`, `_next`: a leading underscore means "required by the signature, intentionally unused".
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },

  // Must stay last: turns off every ESLint rule that would fight with Prettier's formatting.
  prettier,
]);
