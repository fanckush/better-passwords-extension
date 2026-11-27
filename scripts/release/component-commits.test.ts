import { describe, expect, it } from "vitest";
import { analyzeCommits, componentOf, generateNotes, only } from "./component-commits.js";

const logger = { log: () => {}, error: () => {} };
const commit = (message: string, hash = message.length.toString(16).padStart(7, "0")) => ({
  message,
  hash,
  commit: { short: hash.slice(0, 7), long: hash },
  committerDate: "2026-10-14T00:00:00Z",
});

function context(messages: string[]) {
  return {
    commits: messages.map((m) => commit(m)),
    logger,
    cwd: process.cwd(),
    options: { repositoryUrl: "https://github.com/fanckush/better-passwords-extension" },
    lastRelease: { gitTag: "v1.0.0", version: "1.0.0" },
    nextRelease: { gitTag: "v1.1.0", version: "1.1.0" },
  };
}

const config = (component: string) => ({ component, preset: "conventionalcommits" });

describe("componentOf", () => {
  it("assigns companion-scoped commits to the companion and the rest to the extension", () => {
    expect(componentOf("feat(companion): add Touch ID")).toBe("companion");
    expect(componentOf("fix(companion)!: change the XPC protocol\n\nBREAKING CHANGE: x")).toBe("companion");
    expect(componentOf("feat(extension): inline menu")).toBe("extension");
    expect(componentOf("fix(protocol): framing")).toBe("extension");
    expect(componentOf("feat: something")).toBe("extension");
    expect(componentOf("Initial commit")).toBe("extension");
  });
});

describe("analyzeCommits", () => {
  const messages = ["feat(companion): add Touch ID", "fix(extension): menu height", "docs: readme"];

  it("bumps the extension only for its own commits", async () => {
    expect(await analyzeCommits(config("extension"), context(messages))).toBe("patch");
  });

  it("bumps the companion only for companion commits", async () => {
    expect(await analyzeCommits(config("companion"), context(messages))).toBe("minor");
    expect(await analyzeCommits(config("companion"), context(["feat(extension): x"]))).toBeNull();
  });

  it("refuses an unknown component", () => {
    expect(() => analyzeCommits(config("site"), context(messages))).toThrow(/unknown component/);
  });
});

describe("generateNotes", () => {
  it("lists only the component's commits", async () => {
    const messages = ["feat(companion): add Touch ID", "feat(extension): inline menu"];
    const companion = await generateNotes(config("companion"), context(messages));
    expect(companion).toContain("add Touch ID");
    expect(companion).not.toContain("inline menu");
  });
});

describe("only", () => {
  it("passes the context through when commits aren't loaded yet (verifyConditions)", () => {
    const ctx = { logger };
    expect(only(config("companion"), ctx)).toEqual([{ preset: "conventionalcommits" }, ctx]);
  });
});
