import { defineProject } from "vitest/config";

export default defineProject({
  test: { name: "bitwarden", testTimeout: 30_000 },
});
