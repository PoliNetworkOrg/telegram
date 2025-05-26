/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
import pluginJs from "@eslint/js"
import eslintConfigPrettier from "eslint-config-prettier"
import importPlugin from "eslint-plugin-import"
import neverthrow from "eslint-plugin-neverthrow"
import globals from "globals"
import * as tseslint from "typescript-eslint"

export default tseslint.config(
  pluginJs.configs.recommended,
  tseslint.configs.strictTypeChecked,
  importPlugin.flatConfigs.recommended,
  importPlugin.flatConfigs.typescript,
  eslintConfigPrettier,
  {
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: globals.node,
      parserOptions: {
        projectService: {
          allowDefaultProject: ["eslint.config.mjs"],
          defaultProject: "tsconfig.json",
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ["src/**/*.{js,mjs,cjs,ts}"],
    plugins: { neverthrow },
  },
  {
    settings: {
      "import/resolver": {
        typescript: true,
        node: true,
      },
      "import/parsers": {
        "@typescript-eslint/parser": [".ts", ".tsx"],
      },
    },
    rules: {
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          args: "all",
          argsIgnorePattern: "^_",
          caughtErrors: "all",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
      "@typescript-eslint/consistent-type-imports": "error",
      "import/order": [
        "warn",
        {
          groups: ["type", "builtin", "external", "internal", ["index", "parent", "sibling"]],
          alphabetize: { order: "asc" },
          named: true,
          "newlines-between": "always",
        },
      ],
    },
  }
)
