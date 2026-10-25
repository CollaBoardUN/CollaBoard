import { defineConfig } from "vitest/config";

/** Integración SSR: servidor Next compilado + gateway falso (requiere `npm run build`). */
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.int.test.ts"],
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
