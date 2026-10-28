const path = require("node:path");

// Locally, read the repo .env; in CI the variables are set on the job instead.
try {
  process.loadEnvFile(path.join(__dirname, "../../.env"));
} catch {
  // no .env file
}

module.exports = {
  ...require("@codepilot/config/jest.preset.js"),
  testMatch: ["<rootDir>/test/**/*.int-spec.ts"],
};
