// iCloud's Hide My Email as an AliasProvider. It uses the icloud.com sign-in of this browser, so
// requests need icloud.com's Origin: a session rule sets it, only while the user has it turned on
// (session rules don't outlive the browser, so it's set again on every start).

import type { AliasProvider, AliasState } from "../types.ts";
import { HEADER_RULE_ID, HideMyEmail, headerRule, ICloudError } from "./hide-my-email.ts";

export interface ICloudAliasesDeps {
  /** Whether the user has it turned on and allowed its data permissions (Firefox). */
  allowed: () => Promise<boolean>;
  /** The account turned out to have no iCloud+: turn Hide My Email (and its hint) off. */
  withoutICloudPlus: () => Promise<void>;
}

/** How long each site's address is remembered, so reopening the menu is instant. */
const ADDRESS_CACHE_MS = 60_000;

export class ICloudAliases implements AliasProvider {
  readonly id = "icloud";
  readonly label = "Hide My Email";
  readonly #service: HideMyEmail;
  readonly #addresses = new Map<string, { address: string | undefined; at: number }>();

  constructor(private readonly deps: ICloudAliasesDeps) {
    this.#service = new HideMyEmail(async (input, init) => {
      if (!(await deps.allowed())) throw new Error("Turn on Hide My Email and allow its data permissions first.");
      return fetch(input, init);
    });
  }

  async state(hostname: string): Promise<AliasState> {
    try {
      let cached = this.#addresses.get(hostname);
      if (!cached || Date.now() - cached.at > ADDRESS_CACHE_MS) {
        cached = { address: await this.#service.addressFor(hostname), at: Date.now() };
        this.#addresses.set(hostname, cached);
      }
      const { address } = cached;
      return address ? { state: "ready", address } : { state: "ready" };
    } catch (error) {
      if (error instanceof ICloudError && error.code === "signed-out") return { state: "signed-out" };
      if (error instanceof ICloudError && error.code === "no-icloud-plus") {
        await this.deps.withoutICloudPlus();
        return { state: "needs-upgrade" };
      }
      return { state: "error", message: error instanceof Error ? error.message : String(error) };
    }
  }

  generate(): Promise<string> {
    return this.#call(() => this.#service.generate());
  }

  async reserve(address: string, hostname: string): Promise<string> {
    const email = await this.#call(() => this.#service.reserve(address, hostname));
    this.#addresses.set(hostname, { address: email, at: Date.now() });
    return email;
  }

  /** Remembers the address used on a site (one filled in without reserving: it was the site's already). */
  used(address: string, hostname: string): void {
    this.#addresses.set(hostname, { address, at: Date.now() });
  }

  async setEnabled(on: boolean): Promise<void> {
    await browser.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [HEADER_RULE_ID],
      ...(on ? { addRules: [headerRule(new URL(browser.runtime.getURL("/")).host)] } : {}),
    });
    if (!on) {
      this.#service.reset();
      this.#addresses.clear();
    }
  }

  /** Runs a call, turning Hide My Email off if the account turns out to lack iCloud+. */
  async #call<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (error instanceof ICloudError && error.code === "no-icloud-plus") await this.deps.withoutICloudPlus();
      throw error;
    }
  }
}
