import { guardConditionalPasskeys } from "@/src/autofill/passkey-guard.ts";
import { FILL_MATCHES } from "@/src/config.ts";
import { frameOriginToFill } from "@/src/url-policy.ts";

// In the page's own JavaScript world and before its scripts, so the site gets the guarded API. Only
// in frames where our inline menu can show (see autofill.content.ts). Chromium only: issue #29 is
// about Chromium's passkey suggestions, and WXT supports world "MAIN" only in Chromium MV3.
export default defineContentScript({
  matches: FILL_MATCHES,
  allFrames: true,
  runAt: "document_start",
  world: "MAIN",
  include: ["chrome"],
  main() {
    if (frameOriginToFill()) guardConditionalPasskeys();
  },
});
