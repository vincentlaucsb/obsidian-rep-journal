import eslintComments from '@eslint-community/eslint-plugin-eslint-comments';
import obsidianmd from 'eslint-plugin-obsidianmd';
import { defineConfig, globalIgnores } from 'eslint/config';

const nodeOnly = ['src/import-cli.ts', 'src/import-vault.ts', 'src/standalone-*.ts', 'tests/**/*.ts'];
const unusedVariables = { args: 'all', argsIgnorePattern: '^_', caughtErrors: 'all', caughtErrorsIgnorePattern: '^_', ignoreRestSiblings: true };

export default defineConfig(
  globalIgnores([
    'node_modules/**', 'main.js', 'esbuild.config.mjs', 'package.json',
    'package-lock.json', 'tsconfig.json', 'versions.json', 'test-results/**',
  ]),
  ...obsidianmd.configs.recommended,
  {
    plugins: { 'eslint-comments': eslintComments },
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ['eslint.config.mjs', 'manifest.json'] },
        tsconfigRootDir: import.meta.dirname,
        extraFileExtensions: ['.json'],
      },
    },
    rules: {
      'eslint-comments/require-description': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', unusedVariables],
      'obsidianmd/commands/no-plugin-name-in-command-name': 'error',
      'obsidianmd/no-unsupported-api': 'error',
      'obsidianmd/no-tfile-tfolder-cast': 'error',
      'obsidianmd/settings-tab/no-deprecated-display': 'error',
      'obsidianmd/ui/sentence-case': ['warn', { acronyms: ['1RM', 'CSV', 'JSON', 'ID'], enforceCamelCaseLower: true }],
    },
  },
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-deprecated': 'error',
      '@typescript-eslint/no-redundant-type-constituents': 'error',
      '@typescript-eslint/no-unnecessary-type-assertion': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/prefer-promise-reject-errors': 'error',
      '@typescript-eslint/unbound-method': 'error',
    },
  },
  {
    files: ['src/**/*.ts', 'standalone/**/*.js'],
    ignores: [...nodeOnly, 'standalone/bootstrap.js'],
    rules: {
      'obsidianmd/no-nodejs-modules': 'error',
      'no-restricted-syntax': ['error', {
        selector: 'ImportExpression',
        message: 'Use static runtime imports so Obsidian receives a self-contained CommonJS bundle.',
      }, {
        selector: 'CallExpression[callee.type="Identifier"][callee.name=/^(setTimeout|clearTimeout|setInterval|clearInterval)$/]',
        message: 'Use timers from the owning window in plugin UI.',
      }],
    },
  },
  {
    files: nodeOnly,
    rules: {
      // These files run under Node and are outside the mobile plugin bundle.
      'obsidianmd/no-nodejs-modules': 'off',
    },
  },
  {
    files: ['tests/e2e/obsidian.ts'],
    rules: {
      // The UI fixture creates a vault with the default Obsidian configuration directory.
      'obsidianmd/hardcoded-config-path': 'off',
    },
  },
  {
    files: ['standalone/bootstrap.js'],
    languageOptions: { globals: { document: 'readonly' } },
  },
  {
    files: ['standalone/**/*.js'],
    rules: { 'no-dupe-keys': 'error', 'no-undef': 'error', 'no-unreachable': 'error' },
  },
  {
    files: ['tests/standalone.test.ts'],
    rules: { 'no-restricted-globals': 'off' },
  },
);
