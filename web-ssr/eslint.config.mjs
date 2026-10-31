import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

/**
 * Límites de capas (vista de capas del P2):
 *   core/  dominio, transporte y estado; sin React ni Next.
 *   ui/    componentes React reutilizables por la web y Electron; sin Next.
 *   server/, app/  exclusivos de la presentación web SSR.
 */
const forbidNext = {
  group: ["next", "next/*"],
  message: "core/ y ui/ deben funcionar también en Electron: no importes Next.js aquí.",
};
const forbidServer = {
  group: ["@/server/*", "@/app/*", "server-only"],
  message: "core/ y ui/ no pueden depender del servidor web.",
};

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([".next/**", "out/**", "build/**", "coverage/**", "next-env.d.ts", "dev/mocks/node_modules/**"]),
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["src/ui/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [forbidNext, forbidServer] }],
      // ui/ también corre en Electron, donde no existe next/image.
      "@next/next/no-img-element": "off",
    },
  },
  {
    files: ["src/core/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            forbidNext,
            forbidServer,
            { group: ["@/ui/*", "react", "react-dom"], message: "core/ no conoce React ni la interfaz." },
          ],
        },
      ],
    },
  },
  {
    files: ["**/*.test.{ts,tsx}", "tests/**/*.{ts,tsx}"],
    rules: { "no-restricted-imports": "off" },
  },
]);

export default eslintConfig;
