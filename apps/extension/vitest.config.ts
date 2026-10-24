import { defineProject } from "vitest/config";

export default defineProject({
  resolve: { alias: { "@": import.meta.dirname } },
  test: { name: "extension", environment: "happy-dom", include: ["test/**/*.test.ts"] },
});
