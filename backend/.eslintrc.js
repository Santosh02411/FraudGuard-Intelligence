module.exports = {
  root: true,
  env: {
    node: true,
    es2022: true,
    jest: true,
  },
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'script',
  },
  extends: ['eslint:recommended'],
  rules: {
    // Routes/repositories often destructure a response and intentionally
    // leave a field unused (e.g. `const { total: _total, ...rest } = row`)
    // — allow underscore-prefixed unused vars instead of banning the pattern.
    'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    'no-console': 'off', // scripts/ intentionally uses console; logging elsewhere goes through config/logger.js by convention, not enforced by lint
  },
  ignorePatterns: ['node_modules/', 'coverage/'],
};
