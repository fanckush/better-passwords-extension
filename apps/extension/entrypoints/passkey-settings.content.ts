import { ATTRIBUTE_GUARD } from "@/src/autofill/passkey-guard.ts";
import { FILL_MATCHES } from "@/src/config.ts";
import { frameOriginToFill } from "@/src/url-policy.ts";

// The page's guard (passkey-guard.content.ts) reads this attribute when a passkey request comes in,
// so it's enough to set it before the page asks. Off only when the user turned the setting off.
export default defineContentScript({
  matches: FILL_MATCHES,
  allFrames: true,
  runAt: "document_start",
  include: ["chrome"],
  async main() {
    if (!frameOriginToFill()) return;
    const { settings } = await browser.storage.local.get("settings");
    if ((settings as { passkeyGuard?: boolean } | undefined)?.passkeyGuard === false) {
      document.documentElement.setAttribute(ATTRIBUTE_GUARD, "off");
    }
  },
});
