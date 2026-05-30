import js from "@eslint/js";
import tseslint from "typescript-eslint";
import security from "eslint-plugin-security";
import globals from "globals";

export default [
  {
    // Declaration files (*.d.ts / *.d.mts) are pure types with no runtime to
    // lint, and they don't match the typed-linting `**/*.ts` files block (which
    // sets parserOptions.projectService), so type-checked rules would error on
    // them. Skip them — same posture as the existing public/ui ignores.
    ignores: [
      "node_modules/**",
      "public/**",
      "ui/**",
      "eslint.config.js",
      "**/*.d.ts",
      "**/*.d.mts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  security.configs.recommended,
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        ...globals.node,
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/no-non-null-assertion": "warn",
      "no-console": ["warn", { allow: ["warn", "error", "info"] }],
      "security/detect-object-injection": "off",
      "security/detect-non-literal-fs-filename": "off",
    },
  },
  {
    // Plain Node ESM (e.g. lib/board-data.mjs) — not in the TS project, so the
    // type-checked rules can't run; disable them and the fs/child-process
    // security rules (same posture as the .ts block above).
    files: ["**/*.mjs"],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      "security/detect-non-literal-fs-filename": "off",
      "security/detect-child-process": "off",
      "security/detect-object-injection": "off",
    },
  },
  {
    files: ["__tests__/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "security/detect-child-process": "off",
    },
  },
];
