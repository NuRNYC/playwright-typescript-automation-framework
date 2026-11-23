import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import playwright from 'eslint-plugin-playwright';
import prettier from 'eslint-config-prettier/flat';

/**
 * ESLint 10 flat config.
 *
 * Order matters: later entries override earlier ones, which is why the
 * Prettier compatibility layer is last.
 *
 * The important choice here is `projectService: true`. It gives the rules
 * access to the TypeScript type checker, which is what makes
 * `no-floating-promises` possible. Without type information ESLint can only
 * see syntax, and a missing `await` is not a syntax error -- it is a type
 * one. That rule is the entire reason this config exists: in Playwright, a
 * forgotten `await` on a locator action typechecks clean, passes, and
 * produces an intermittent failure later.
 */
export default tseslint.config(
  {
    ignores: ['node_modules/**', 'playwright-report/**', 'test-results/**'],
  },

  js.configs.recommended,

  {
    // Type-aware linting is scoped to .ts files: this config file is .mjs and
    // is deliberately not part of the TypeScript project.
    files: ['**/*.ts'],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Already errors via recommendedTypeChecked. Restated because it is the
      // single most valuable rule in a Playwright repo and should not be
      // silently weakened by a future config edit.
      '@typescript-eslint/no-floating-promises': 'error',

      // Catches `await somethingNotAPromise` -- usually a sign of a missing
      // call, e.g. `await page.title` instead of `await page.title()`.
      '@typescript-eslint/await-thenable': 'error',

      // Page objects return Promises; passing one where a sync value is
      // expected is almost always a forgotten await.
      '@typescript-eslint/no-misused-promises': 'error',

      // Unused variables are an error, but allow a leading underscore as the
      // deliberate "I know, and I mean it" escape hatch.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },

  {
    // Node's built-in test runner returns a Promise from `test()`, so every
    // call in a unit-test file is a floating promise. ESLint is correct about
    // that, and the runner handles the lifecycle itself.
    //
    // Rather than disabling the rule -- which would also hide genuine missing
    // awaits in these files -- it stays at 'error' and only node:test's own
    // lifecycle functions are declared safe. The specifier is pinned to the
    // `node:test` package, so a same-named helper from anywhere else is still
    // reported.
    files: ['src/**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-floating-promises': [
        'error',
        {
          allowForKnownSafeCalls: [
            {
              from: 'package',
              package: 'node:test',
              name: [
                'test',
                'it',
                'describe',
                'suite',
                'before',
                'after',
                'beforeEach',
                'afterEach',
              ],
            },
          ],
        },
      ],
    },
  },

  {
    // Playwright-specific rules apply only to test files, not to page objects.
    // flat/recommended covers no-wait-for-timeout, no-conditional-in-test,
    // expect-expect, no-skipped-test, no-focused-test and others.
    // Scoped to tests/** so unit tests under src/** are untouched by them.
    ...playwright.configs['flat/recommended'],
    files: ['tests/**/*.ts'],
  },

  // Must stay last: switches off every rule that would fight Prettier over
  // formatting. ESLint judges correctness here; Prettier owns layout.
  prettier,
);
