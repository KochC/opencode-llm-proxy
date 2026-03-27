import js from "@eslint/js"

export default [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        // Node.js globals
        process: "readonly",
        globalThis: "readonly",
        crypto: "readonly",
        // Bun globals (used in OpenAIProxyPlugin)
        Bun: "readonly",
        // Web API globals available in both Node and Bun
        Request: "readonly",
        Response: "readonly",
        URL: "readonly",
      },
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-console": "warn",
    },
  },
  {
    // Relax rules for the test file
    files: ["*.test.js"],
    languageOptions: {
      globals: {
        // node:test globals
        describe: "readonly",
        it: "readonly",
        before: "readonly",
        after: "readonly",
        beforeEach: "readonly",
        afterEach: "readonly",
      },
    },
    rules: {
      "no-unused-vars": "off",
    },
  },
  {
    ignores: ["node_modules/"],
  },
]
