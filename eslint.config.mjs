import tseslint from 'typescript-eslint';

export default tseslint.config(
  // Global: warn on `as` casts (10 existing violations in source, 8 in tests)
  {
    files: ['src/**/*.ts'],
    extends: [tseslint.configs.base],
    rules: {
      '@typescript-eslint/consistent-type-assertions': ['warn', {
        assertionStyle: 'never',
      }],
    },
  },

  // Strict: error on `as` casts in new primitives — zero tolerance
  {
    files: ['src/conditional.ts', 'src/as-step.ts', 'src/middleware.ts'],
    rules: {
      '@typescript-eslint/consistent-type-assertions': ['error', {
        assertionStyle: 'never',
      }],
    },
  },
);
