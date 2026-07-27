export default {
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/?(*.)+(test).[jt]s'],
  setupFiles: ['<rootDir>/tests/helpers/env.setup.js'],
  transform: {},
  testTimeout: 20000,
  maxWorkers: 1,
};
