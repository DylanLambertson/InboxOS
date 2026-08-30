import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Separate from vite.config.ts so unit tests run in plain Node without the Workers runtime.
export default defineConfig({
  resolve: { alias: { "@shared": fileURLToPath(new URL("./shared", import.meta.url)) } },
  test: { include: ["tests/**/*.test.ts"], environment: "node" },
});
