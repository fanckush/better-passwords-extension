// Verification codes as the extension's pages see them: which account and site, never the digits.
// The helper withholds those until Touch ID anyway (see docs/protocol.md), and a fill always asks
// it for the code current at that moment.

import type { OneTimeCode } from "@app/protocol";
import type { OneTimeCodeView } from "../messages.ts";

/** Names a code across requests; the background lists the codes again to find it. */
export function oneTimeCodeId(code: Pick<OneTimeCode, "source" | "username" | "domain">): string {
  return JSON.stringify([code.source, code.username, code.domain]);
}

/** The codes to offer, the account just signed in with first, each account once. */
export function oneTimeCodeViews(codes: readonly OneTimeCode[], signedInAs?: string): OneTimeCodeView[] {
  const seen = new Set<string>();
  const views: OneTimeCodeView[] = [];
  for (const code of codes) {
    const id = oneTimeCodeId(code);
    if (seen.has(id)) continue;
    seen.add(id);
    views.push({ id, username: code.username, domain: code.domain });
  }
  const current = signedInAs?.toLowerCase();
  if (!current) return views;
  const first = views.filter((view) => view.username.toLowerCase() === current);
  return [...first, ...views.filter((view) => !first.includes(view))];
}
