import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: { environment: "node", include: ["tests/**/*.test.ts"], testTimeout: 10_000 },
  // No trailing slash, so "@/lib/x" resolves to "<root>/lib/x" on Windows and Linux alike.
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)).replace(/[\/]$/, "") } },
});
