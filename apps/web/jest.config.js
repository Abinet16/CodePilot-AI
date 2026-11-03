/**
 * Unit tests for the web app's pure logic (formatting, diff parsing, progress).
 * Pages and components are covered end to end by Playwright in tests/e2e.
 */
module.exports = {
  ...require("@codepilot/config/jest.preset.js"),
  transform: {
    "^.+\\.ts$": ["ts-jest", { tsconfig: "<rootDir>/tsconfig.test.json", diagnostics: { warnOnly: false } }],
  },
  testMatch: ["<rootDir>/src/lib/**/*.spec.ts"],
};
