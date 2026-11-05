import { describe, expect, it } from "vitest";
import { REPO_URL, SUPPORT_EMAIL } from "../src/config.ts";
import { reportLinks } from "../src/ui/report.ts";

const details = { version: "1.3.1", browser: "Google Chrome 141.0.7390.54", os: "macOS 26.1.0" };

describe("reportLinks", () => {
  it("opens the bug form with the details filled in", () => {
    const url = new URL(reportLinks(details).github);
    expect(`${url.origin}${url.pathname}`).toBe(`${REPO_URL}/issues/new`);
    expect(Object.fromEntries(url.searchParams)).toEqual({ template: "bug.yml", ...details });
  });

  it("leaves out details it couldn't read", () => {
    const url = new URL(reportLinks({ version: "1.3.1", browser: "Firefox 145.0" }).github);
    expect(url.searchParams.has("os")).toBe(false);
    expect(new URL(reportLinks({}).github).search).toBe("?template=bug.yml");
  });

  it("writes an email with the details and the warning", () => {
    const url = new URL(reportLinks(details).email);
    expect(url.protocol).toBe("mailto:");
    expect(url.pathname).toBe(SUPPORT_EMAIL);
    const subject = decodeURIComponent(url.search.match(/subject=([^&]*)/)?.[1] ?? "");
    const body = decodeURIComponent(url.search.match(/body=([^&]*)/)?.[1] ?? "");
    expect(subject).toBe("Better Passwords: problem report");
    expect(body).toContain("Extension version: 1.3.1");
    expect(body).toContain("Browser: Google Chrome 141.0.7390.54");
    expect(body).toContain("System: macOS 26.1.0");
    expect(body).toContain("never include passwords");
    // spaces stay spaces in mail apps
    expect(url.search).not.toContain("+");
  });
});
