// A way to report a problem from inside the extension, for people who found it in a store and
// never saw the repository: email first, since GitHub's bug form asks most of them to sign in.
// Both are pre-filled with versions only; nothing is sent until the user sends it.

import { DISPLAY_NAME, REPO_URL, SUPPORT_EMAIL } from "../config.ts";
import { h } from "./h.ts";

/** What a bug report needs and people often leave out. Each is optional: it may not be readable. */
export interface ReportDetails {
  version?: string;
  browser?: string;
  macos?: string;
}

const WARNING = "Please never include passwords, pairing codes or screenshots showing them.";

/** The pre-filled bug form and email. The query keys are the field ids in .github/ISSUE_TEMPLATE/bug.yml. */
export function reportLinks(details: ReportDetails): { github: string; email: string } {
  const form = new URLSearchParams({ template: "bug.yml" });
  for (const [key, value] of Object.entries(details)) if (value) form.set(key, value);

  const lines = [
    ["Extension version", details.version],
    ["Browser", details.browser],
    ["macOS", details.macos],
  ]
    .filter(([, value]) => value)
    .map(([label, value]) => `${label}: ${value}`);
  const body = ["What happened, and what did you expect?", "", "", "---", ...lines, "", WARNING].join("\n");
  // URLSearchParams encodes spaces as "+", which mail apps show as is
  const mail = `subject=${encodeURIComponent(`${DISPLAY_NAME}: problem report`)}&body=${encodeURIComponent(body)}`;

  return { github: `${REPO_URL}/issues/new?${form}`, email: `mailto:${SUPPORT_EMAIL}?${mail}` };
}

/** Chromium's User-Agent Client Hints; the user-agent string itself always says macOS 10.15.7. */
interface UADataValues {
  platform?: string;
  platformVersion?: string;
  fullVersionList?: { brand: string; version: string }[];
}
type UAData = { getHighEntropyValues(hints: string[]): Promise<UADataValues> };

/** Reads the details this browser exposes; whatever it can't read is left out. */
export async function reportDetails(): Promise<ReportDetails> {
  const details: ReportDetails = {};
  try {
    details.version = browser.runtime.getManifest().version;
  } catch {
    // left for the user to fill in
  }
  if (import.meta.env.FIREFOX) {
    try {
      const runtime = browser.runtime as unknown as { getBrowserInfo(): Promise<{ name: string; version: string }> };
      const { name, version } = await runtime.getBrowserInfo();
      details.browser = `${name} ${version}`;
    } catch {
      // left for the user to fill in
    }
    return details;
  }
  try {
    const uaData = (navigator as Navigator & { userAgentData?: UAData }).userAgentData;
    const values = await uaData?.getHighEntropyValues(["fullVersionList", "platformVersion"]);
    // the browser's own brand, not Chromium or the made-up "Not A Brand" entries
    const brands = values?.fullVersionList ?? [];
    const brand =
      brands.find((b) => !/not.a.brand|^chromium$/i.test(b.brand)) ?? brands.find((b) => b.brand === "Chromium");
    if (brand) details.browser = `${brand.brand} ${brand.version}`;
    if (values?.platform === "macOS" && values.platformVersion) details.macos = values.platformVersion;
  } catch {
    // left for the user to fill in
  }
  return details;
}

/** This browser's own name ("Ardia", "Google Chrome"), without its version; undefined if it doesn't say. */
export async function browserName(): Promise<string | undefined> {
  const browser = (await reportDetails()).browser;
  return browser?.replace(/\s+[\d.]+$/, "") || undefined;
}

/** "Something wrong? Email the developer or report it on GitHub." */
export function reportProblem(): HTMLElement {
  const plain = reportLinks({});
  const github = h("a", { href: plain.github, target: "_blank", rel: "noopener", textContent: "report it on GitHub" });
  // the address on hover, for anyone without a mail app to open
  const email = h("a", { href: plain.email, title: SUPPORT_EMAIL, textContent: "Email the developer" });
  // the links work right away; they gain the details as soon as those are read
  void reportDetails().then((details) => {
    const links = reportLinks(details);
    github.href = links.github;
    email.href = links.email;
  });
  return h("p", { class: "report" }, "Something wrong? ", email, " or ", github, ".");
}
