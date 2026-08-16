import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["client/src/**/*.test.ts", "src/**/*.test.ts"],
    setupFiles: ["./vitest.setup.ts"],
  },
});
