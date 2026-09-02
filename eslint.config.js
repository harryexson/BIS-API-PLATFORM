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
  }
);
