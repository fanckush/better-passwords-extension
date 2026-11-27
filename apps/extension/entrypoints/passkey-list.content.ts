import { watchPasskeyLists } from "@/src/autofill/passkey-list.ts";
import { FILL_MATCHES } from "@/src/config.ts";
import type { Settings } from "@/src/messages.ts";
import { frameOriginToFill } from "@/src/url-policy.ts";

// Hides the browser's passkey list on login fields (see passkey-list.ts), from the start of the page
// so the browser never sees a tagged field. Only where our inline menu runs, and only while it does:
// the menu is how the user gets the browser's list back. Chromium only: issue #29 is about its list.
export default defineContentScript({
  matches: FILL_MATCHES,
  allFrames: true,
  runAt: "document_start",
  include: ["chrome"],
  main() {
    if (!frameOriginToFill()) return;
    // on until the settings say otherwise: both settings are on by default, and reading them takes a moment
    const stop = watchPasskeyLists();
    browser.storage.local.get("settings").then(
      ({ settings }) => {
        const saved = settings as Partial<Settings> | undefined;
        if (saved?.hidePasskeyList === false || saved?.inlineMenu === false) stop();
      },
      () => {},
    );
  },
});
