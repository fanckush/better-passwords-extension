// Wires an AppleAccount into the browser: its native host, what it remembers across background
// workers, and the companion app (Mac only), which can enter its code and hears when macOS blocks
// the helper.

import type { Companion } from "../../companion.ts";
import { BRIDGE_HOST } from "../../config.ts";
import { PortTransport } from "../../native/port-transport.ts";
import { platform } from "../../platform.ts";
import { AppleAccount } from "./account.ts";

// macOS kills Apple's helper in browsers Apple doesn't allow, and every try leaves a crash report
// on the Mac. So a blocked browser tries once per launch, plus whenever the user asks (the session
// refuses otherwise). Workers restart often, so it's remembered for the browser session.
const HELPER_BLOCKED = "helperBlocked";
// Told the Mac app this browser is blocked, so it hears once it isn't any more.
const REPORTED_BLOCKED = "reportedBlocked";

export function createAppleAccount(id: string, companion: Companion): AppleAccount {
  const account = new AppleAccount(id, {
    openTransport: () => new PortTransport(BRIDGE_HOST),
    browserName: import.meta.env.FIREFOX ? "Firefox" : "Chrome",
    blockedEarlier: async () => {
      const stored = (await browser.storage.session.get(HELPER_BLOCKED))[HELPER_BLOCKED];
      return typeof stored === "string" ? stored : undefined;
    },
    windows: async () => (await platform()) === "windows",
    readCode: () => companion.readCode(),
    touchIdReady: async () => (await companion.state()) === "ready",
  });

  let blocked = false;
  account.onChange(({ state, error, remembered }) => {
    if (state === "unavailable") {
      blocked = true;
      void browser.storage.session.set({ [HELPER_BLOCKED]: error ?? "" }).catch(() => {});
      // a worker that restored it has nothing new to tell
      if (remembered) return;
      void companion.reportHelper(true);
      void browser.storage.local.set({ [REPORTED_BLOCKED]: true });
      return;
    }
    // anything else, even a retry that timed out, isn't macOS blocking the helper
    if (blocked) {
      blocked = false;
      void browser.storage.session.remove(HELPER_BLOCKED).catch(() => {});
    }
    // only the helper answering shows it isn't blocked any more
    if (state !== "locked" && state !== "unlocking" && state !== "unlocked") return;
    void browser.storage.local.get(REPORTED_BLOCKED).then(async (stored) => {
      if (stored[REPORTED_BLOCKED] !== true) return;
      await companion.reportHelper(false);
      await browser.storage.local.remove(REPORTED_BLOCKED);
    });
  });
  return account;
}
