import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/.next/**", "**/node_modules/**", "**/coverage/**", "**/next-env.d.ts"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
  {
    // Tool config files (jest.config.js etc.) are CommonJS running in Node.
    files: ["**/*.js"],
    languageOptions: { sourceType: "commonjs", globals: { module: "writable", require: "readonly", process: "readonly", __dirname: "readonly" } },
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  {
    // NestJS relies on runtime class references for dependency injection.
    files: ["apps/api/**/*.ts", "apps/worker/**/*.ts"],
    rules: { "@typescript-eslint/consistent-type-imports": "off" },
  },
);
