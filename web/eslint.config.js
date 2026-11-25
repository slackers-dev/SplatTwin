// Lint fuer den Web-Teil. Die Regeln zu Importen setzen die Abhaengigkeiten aus
// docs/architektur.md durch: core ist reine Mathematik, tracking und avatar kennen sich nicht,
// nur die Seiten (pages) stecken alles zusammen.
import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

const restrict = (...patterns) => ({
  'no-restricted-imports': ['error', { patterns: patterns.map(([group, message]) => ({ group, message })) }],
});

const PAGES = [['**/pages/**'], 'Nur Seiten (src/pages) duerfen andere Seiten kennen.'];

export default defineConfig(
  { ignores: ['dist/', '.tsbuild/', 'node_modules/', 'src/contracts/generated.ts'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly' } },
  },
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    files: ['src/core/**/*.ts', 'src/contracts/**/*.ts'],
    rules: restrict(
      [['three', 'three/*', '@mediapipe/*', '@sparkjsdev/*'], 'core ist reine Mathematik ohne Bibliotheken.'],
      [['**/tracking/**', '**/avatar/**', '**/capture/**', '**/live/**', '**/slides/**', '**/ui/**', '**/pages/**'], 'core haengt von nichts ausser contracts ab.'],
    ),
  },
  {
    files: ['src/tracking/**/*.ts'],
    rules: restrict(
      [['three', 'three/*', '@sparkjsdev/*', '**/avatar/**'], 'tracking kennt den Avatar nicht (Punkte als Vec3).'],
      PAGES,
    ),
  },
  {
    files: ['src/avatar/**/*.ts'],
    rules: restrict([['@mediapipe/*', '**/tracking/**', '**/capture/**'], 'avatar kennt das Tracking nicht.'], PAGES),
  },
  {
    files: ['src/capture/**/*.ts', 'src/live/**/*.ts', 'src/slides/**/*.ts', 'src/ui/**/*.ts'],
    rules: restrict([['three', 'three/*', '@sparkjsdev/*', '**/avatar/**'], 'Ohne three.js: das ist Sache von avatar.'], PAGES),
  },
);
