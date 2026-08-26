import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    // Unit tests only — integration tests run via vitest.integration.config.mts
    include: [
      "src/__tests__/**/*.test.ts",
      // Top-level tests directory (auth policy matrix, openapi contract, etc.)
      "tests/**/*.test.ts",
    ],
    // Integration tests need live Postgres/Redis and run via
    // vitest.integration.config.mts in their own CI job.
    exclude: ["**/node_modules/**", "src/__tests__/integration/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "text-summary", "lcov", "json-summary"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.d.ts",
        "src/**/__tests__/**",
        "src/generate-openapi.ts",
        "src/cli.ts",
      ],
      // ── Coverage thresholds (Issue #10 ratchet) ─────────────────────────
      // Fail the CI run when any metric drops below these baselines.
      // Raise them as coverage improves; do not lower without review.
      thresholds: {
        statements: 60,
        branches: 50,
        functions: 55,
        lines: 60,
      },
    },
  },
});
