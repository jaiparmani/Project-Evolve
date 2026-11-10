/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/?(*.)+(spec|test).js'],
  clearMocks: true,
  collectCoverageFrom: ['server.js', '!node_modules/**'],
};
