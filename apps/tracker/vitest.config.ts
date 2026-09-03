import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Resolve workspace @adstrackio/* packages to their TypeScript
    // source (see their package.json "development" export condition)
    // instead of requiring `pnpm build` to have run first — matches
    // the "dev" scripts, which pass the same --conditions=development.
    conditions: ["development"],
  },
  test: {
    environment: "node",
    globals: false,
    setupFiles: ["./test/setup.ts"],
    testTimeout: 20000,
    hookTimeout: 20000,
    fileParallelism: false,
  },
});
