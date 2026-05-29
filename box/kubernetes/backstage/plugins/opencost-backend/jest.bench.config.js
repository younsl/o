/** @type {import('jest').Config} */
module.exports = {
  transform: {
    '^.+\\.tsx?$': ['@swc/jest'],
  },
  testMatch: ['**/*.bench.test.ts'],
  testEnvironment: 'node',
  verbose: true,
};
