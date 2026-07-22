import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import importX from 'eslint-plugin-import-x';
import globals from 'globals';

export default [
  {
    // Generated Prisma client and build output are never linted.
    ignores: ['node_modules/**', 'generated/**', 'coverage/**', 'dist/**'],
  },

  js.configs.recommended,

  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    plugins: {
      'import-x': importX,
    },
    settings: {
      'import-x/resolver': {
        node: {
          extensions: ['.js', '.mjs', '.cjs'],
        },
      },
    },
    rules: {
      // --- Correctness ---------------------------------------------------
      'no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      'no-console': ['error', { allow: ['error', 'warn'] }],
      eqeqeq: ['error', 'smart'],
      'no-var': 'error',
      'prefer-const': 'error',
      'no-return-await': 'error',
      'require-atomic-updates': 'error',

      // --- Money safety ----------------------------------------------------
      // ADR-004 control M2. Prisma returns NUMERIC columns as Decimal objects;
      // `.toNumber()` followed by arithmetic silently reverts to binary
      // floating point and produces a ledger that is wrong by a few paise a
      // month with nothing failing loudly. Arithmetic belongs in
      // shared/utils/money.js, which is the only file exempt from this rule.
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.property.name='toNumber']",
          message:
            'Do not call .toNumber() on a Decimal - it reintroduces floating point. Use shared/utils/money.js (ADR-004, control M2).',
        },
        {
          selector: "CallExpression[callee.name='parseFloat']",
          message:
            'parseFloat produces a double. Use shared/utils/money.js for money and quantities (ADR-004).',
        },
      ],

      // --- Module hygiene -------------------------------------------------
      // Circular imports between modules are the failure mode that turns a
      // modular monolith back into a big ball of mud, and they surface as
      // baffling "undefined is not a function" errors at runtime.
      'import-x/no-cycle': ['error', { maxDepth: 10 }],
      'import-x/no-self-import': 'error',
      'import-x/no-useless-path-segments': 'error',
      'import-x/order': [
        'error',
        {
          groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index'],
          'newlines-between': 'always',
          alphabetize: { order: 'asc', caseInsensitive: true },
        },
      ],
    },
  },

  {
    // Config files at the root run before/outside the app.
    files: ['*.config.js', 'prisma.config.js'],
    rules: {
      'no-console': 'off',
    },
  },

  {
    // env.js must report configuration failures before the logger exists.
    files: ['src/config/env.js'],
    rules: {
      'no-console': 'off',
    },
  },

  {
    // Operator CLI scripts. Their console output IS the user interface, and
    // they must not route through pino - a generated admin password printed
    // once to a terminal must never reach the log aggregator.
    files: ['prisma/seed.js', 'scripts/**/*.js', 'scripts/**/*.mjs'],
    rules: {
      'no-console': 'off',
    },
  },

  // Must stay last: turns off every stylistic rule that would fight Prettier.
  prettier,
];
