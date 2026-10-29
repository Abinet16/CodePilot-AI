/** Shared Jest preset for TypeScript packages in the monorepo. */
module.exports = {
  testEnvironment: "node",
  transform: {
    "^.+\\.ts$": ["ts-jest", { tsconfig: "<rootDir>/tsconfig.json", diagnostics: { warnOnly: false } }],
  },
  testMatch: ["<rootDir>/src/**/*.spec.ts", "<rootDir>/test/**/*.spec.ts"],
  moduleFileExtensions: ["ts", "js", "json"],
  // Workspace packages are consumed from source during tests so no prior build is needed.
  moduleNameMapper: {
    "^@codepilot/contracts$": "<rootDir>/../../packages/contracts/src/index.ts",
    "^@codepilot/agent-core$": "<rootDir>/../../packages/agent-core/src/index.ts",
    "^@codepilot/github$": "<rootDir>/../../packages/github/src/index.ts",
  },
};
