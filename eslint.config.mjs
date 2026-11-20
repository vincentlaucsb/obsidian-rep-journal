import obsidianmd from 'eslint-plugin-obsidianmd';
import { defineConfig, globalIgnores } from 'eslint/config';

export default defineConfig(
  globalIgnores([
    'node_modules/**', 'main.js', 'esbuild.config.mjs', 'package.json',
    'package-lock.json', 'tsconfig.json', 'versions.json',
  ]),
  ...obsidianmd.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ['eslint.config.mjs', 'manifest.json'] },
        tsconfigRootDir: import.meta.dirname,
        extraFileExtensions: ['.json'],
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-deprecated': 'error',
      'obsidianmd/no-unsupported-api': 'error',
      'obsidianmd/ui/sentence-case': ['warn', { acronyms: ['1RM', 'CSV', 'JSON', 'ID'], enforceCamelCaseLower: true }],
    },
  },
  {
    files: ['tests/**/*.ts'],
    rules: {
      // These files run under Node and are outside the mobile plugin bundle.
      'obsidianmd/no-nodejs-modules': 'off',
    },
  },
);
