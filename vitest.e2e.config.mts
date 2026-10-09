import { defineConfig } from "vitest/config";
import path from "node:path";

// Real-browser layout tests against the production build. Run `npm run build` first.
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "server-only": path.resolve(import.meta.dirname, "tests/support/empty.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/e2e/**/*.e2e.test.ts"],
    setupFiles: ["tests/support/setup.ts"],
    testTimeout: 90000,
    fileParallelism: false,
  },
});
