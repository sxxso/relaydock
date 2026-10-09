import { defineConfig } from "vitest/config";
export default defineConfig({
  // Fixtures must never inherit the private deployment's .env.local.
  envDir: false,
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    fileParallelism: false,
  },
});
