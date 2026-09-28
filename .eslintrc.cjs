module.exports = {
  root: true,
  extends: ['taro/react'],
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 2022, sourceType: 'module', ecmaFeatures: { jsx: true } },
  env: { browser: true, node: true, es2022: true },
  ignorePatterns: ['dist/', 'www/', 'release/', 'node_modules/'],
  rules: {
    'react/react-in-jsx-scope': 'off',
    'import/no-commonjs': 'off',
    'import/first': 'off',
    'jsx-quotes': 'off',
    'import/newline-after-import': 'off',
    'no-restricted-globals': 'off',
    'no-shadow': 'off',
    'no-unused-vars': 'off',
    'react/jsx-closing-bracket-location': 'off'
  }
};
