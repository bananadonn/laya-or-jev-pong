/** @type {import("eslint").Linter.Config} */
module.exports = {
  root: true,
  parser: "@typescript-eslint/parser",
  parserOptions: {
    project: ["./tsconfig.json", "./tsconfig.node.json"],
    tsconfigRootDir: __dirname,
    sourceType: "module",
  },
  plugins: ["@typescript-eslint", "import", "promise"],
  extends: [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended-requiring-type-checking",
    "plugin:import/recommended",
    "plugin:import/typescript",
    "plugin:promise/recommended",
  ],
  env: { browser: true, es2022: true, node: true },
  ignorePatterns: ["dist", "node_modules", "server", "*.cjs"],
  rules: {
    "@typescript-eslint/no-floating-promises": "error",
    "import/no-cycle": "error",
    "import/no-unresolved": "off",
  },
  overrides: [
    {
      files: ["src/render/**/*.ts"],
      rules: {
        "no-restricted-imports": [
          "error",
          {
            patterns: [
              {
                group: ["**/decisions/*", "**/decisions", "../decisions/*", "../../decisions/*"],
                message:
                  "render/ must not import from decisions/ — the whole point is that drawing knows nothing about decision logic.",
              },
            ],
          },
        ],
      },
    },
  ],
};
