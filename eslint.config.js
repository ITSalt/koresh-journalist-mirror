import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/', 'data/', 'coverage/'] },
  ...tseslint.configs.recommended,
);
