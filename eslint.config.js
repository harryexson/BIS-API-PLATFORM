const js = require('@eslint/js');
const tseslint = require('typescript-eslint');

module.exports = tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^(.*)$' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-empty-object-type': 'warn',
      '@typescript-eslint/explicit-function-return-type': 'off',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'prefer-const': 'warn',
      'no-useless-assignment': 'warn',
      'preserve-caught-error': 'off',
    },
  },
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      '**/*.js',
      '**/*.d.ts',
      'apps/**',
      '**/drizzle/**',
      '**/vitest.config.*',
      '**/eslint.config.*',
    ],
  },
  {
    files: ['packages/**/*.ts', 'services/**/*.ts'],
  },
  // Phase 22 (gap register C18): production code logs ONLY through the
  // structured, redacting logger (@company/observability). The base rule above
  // still allowed console.warn/console.error — exactly the calls that
  // bypassed redaction. Tests, test fixtures/utilities, the load-test CLI and
  // the simulation harness are not production code paths. (A rule, not
  // 'no-console': its inherited `allow: [warn, error]` option would survive a
  // severity-only override.)
  {
    files: ['packages/**/*.ts', 'services/**/*.ts'],
    ignores: ['**/*.test.ts', '**/test-fixtures/**', '**/test-utils/**', 'packages/loadtest/**', 'packages/simulation/**'],
    rules: {
      'no-restricted-properties': [
        'error',
        { object: 'console', message: 'Log through the structured, redacting logger from @company/observability (gap register C18).' },
      ],
    },
  }
);
