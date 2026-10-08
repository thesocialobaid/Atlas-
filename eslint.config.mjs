import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // One place constructs the AI client, wrapped so every call is traced. A
  // client built anywhere else would work and silently skip tracing.
  {
    files: ["**/*.{ts,tsx,mjs,js}"],
    ignores: ["lib/ai/client.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        { paths: [{ name: "openai", message: "Use chat() from lib/ai/client.ts: it's the traced client." }] },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
