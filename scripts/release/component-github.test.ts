import { beforeEach, describe, expect, it, vi } from "vitest";

const github = vi.hoisted(() => ({
  verifyConditions: vi.fn(),
  publish: vi.fn(),
  addChannel: vi.fn(),
  success: vi.fn(),
  fail: vi.fn(),
}));
vi.mock("@semantic-release/github", () => github);

const plugin = await import("./component-github.js");

const commit = (message: string) => ({ message, hash: message });
const messages = ["feat(companion): add Touch ID", "fix(extension): add CSP (#22)", "docs: readme"];
const context = () => ({ commits: messages.map(commit), logger: console });
const assets = [{ path: "dist/updates/*.dmg" }];

describe("component-github", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(["verifyConditions", "publish", "addChannel", "success", "fail"] as const)(
    "passes only the companion's commits and the GitHub options to %s",
    async (step) => {
      const extra = { Octokit: class {} };
      await plugin[step]({ component: "companion", assets }, context(), extra);
      expect(github[step]).toHaveBeenCalledWith(
        { assets },
        expect.objectContaining({ commits: [commit("feat(companion): add Touch ID")] }),
        extra,
      );
    },
  );

  it("passes the extension every commit not scoped to the companion", async () => {
    await plugin.success({ component: "extension" }, context());
    expect(github.success.mock.calls[0]?.[1].commits.map((c: { message: string }) => c.message)).toEqual([
      "fix(extension): add CSP (#22)",
      "docs: readme",
    ]);
  });

  it("refuses an unknown component", () => {
    expect(() => plugin.success({ component: "site" }, context())).toThrow(/unknown component/);
  });
});
