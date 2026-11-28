import { watchPasskeyLists } from "@/src/autofill/passkey-list.ts";
import { FILL_MATCHES } from "@/src/config.ts";
import type { Settings } from "@/src/messages.ts";
import { frameOriginToFill } from "@/src/url-policy.ts";

// Hides the browser's passkey list on login fields (see passkey-list.ts), from the start of the page
// so the browser never sees a tagged field. Only where our inline menu opens on a click in the field,
// and only while it does: the menu is how the user gets the browser's list back. In minimal mode the
// menu opens from our icon instead, so a click in the field is the browser's. Chromium only: issue
// #29 is about its list.
export default defineContentScript({
  matches: FILL_MATCHES,
  allFrames: true,
  runAt: "document_start",
  include: ["chrome"],
  main(ctx) {
    if (!frameOriginToFill()) return;
    // on until the settings say otherwise: on by default, and reading them takes a moment
    let stop: (() => void) | undefined = watchPasskeyLists();
    const apply = (settings: unknown) => {
      const saved = settings as Partial<Settings> | undefined;
      const hide = saved?.hidePasskeyList !== false && saved?.inlineMenu !== false && saved?.minimalMode !== true;
      if (hide && !stop) stop = watchPasskeyLists();
      if (!hide && stop) {
        stop();
        stop = undefined;
      }
    };
    browser.storage.local.get("settings").then(
      ({ settings }) => apply(settings),
      () => {},
    );
    const changed = (changes: Record<string, { newValue?: unknown }>, area: string) => {
      if (area === "local" && changes.settings) apply(changes.settings.newValue);
    };
    browser.storage.onChanged.addListener(changed);
    ctx.onInvalidated(() => browser.storage.onChanged.removeListener(changed));
  },
});
