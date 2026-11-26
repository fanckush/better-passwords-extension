// Keeps the browser's own passkey list out of login fields, where it shows over our inline menu
// (issue #29). Sites ask for that list with a "conditional" WebAuthn request. While the guard is on,
// we tell sites it isn't available and hold any such request. The menu can then "show the browser's
// passkey list" (release): held requests go to the browser, and later ones pass through, until the
// page reloads. The site's own passkey button makes a normal request, which is never held.
//
// Page-side state is shared with the isolated content script through the page's DOM only:
// - ATTRIBUTE_GUARD="off" turns the guard off (set at document_start from the setting);
// - ATTRIBUTE_HELD="true" while a request is held, with EVENT_HELD dispatched when that changes;
// - EVENT_RELEASE, dispatched by the content script, releases the held requests.

export const ATTRIBUTE_GUARD = "data-better-passwords-passkey-guard";
export const ATTRIBUTE_HELD = "data-better-passwords-passkey-held";
export const EVENT_HELD = "better-passwords:passkey-held";
export const EVENT_RELEASE = "better-passwords:release-passkey";

/** The static members of PublicKeyCredential we change; not all browsers have them. */
interface PasskeyApi {
  isConditionalMediationAvailable?: () => Promise<boolean>;
  getClientCapabilities?: () => Promise<Record<string, boolean>>;
}

interface Held {
  container: CredentialsContainer;
  options: CredentialRequestOptions;
  resolve: (credential: Credential | null) => void;
  reject: (reason: unknown) => void;
  forget: () => void;
}

/** Must run in the page's own JavaScript world, before the site's scripts. */
export function guardConditionalPasskeys(view: Window & typeof globalThis = window): void {
  const credentials = view.CredentialsContainer?.prototype;
  const publicKey = view.PublicKeyCredential as unknown as PasskeyApi | undefined;
  if (!credentials || !publicKey) return;

  const root = () => view.document.documentElement;
  const held = new Set<Held>();
  // checked at call time: the attribute is set a moment after the page starts, before it asks
  const guarding = () => root()?.getAttribute(ATTRIBUTE_GUARD) !== "off";

  const update = () => {
    root()?.setAttribute(ATTRIBUTE_HELD, held.size > 0 ? "true" : "false");
    view.dispatchEvent(new Event(EVENT_HELD));
  };

  // sites that check first usually show their own passkey button instead
  const available = publicKey.isConditionalMediationAvailable;
  if (available) {
    publicKey.isConditionalMediationAvailable = () => (guarding() ? Promise.resolve(false) : available.call(publicKey));
  }
  const capabilities = publicKey.getClientCapabilities;
  if (capabilities) {
    publicKey.getClientCapabilities = () =>
      capabilities.call(publicKey).then((found) => (guarding() ? { ...found, conditionalGet: false } : found));
  }

  const get = credentials.get;
  credentials.get = function (this: CredentialsContainer, options?: CredentialRequestOptions) {
    if (options?.mediation !== "conditional" || !options.publicKey || !guarding()) {
      return get.call(this, options);
    }
    // as if the user never picked a passkey: it ends when the site aborts it, or when the user shows it once
    const signal = options.signal;
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise<Credential | null>((resolve, reject) => {
      const entry: Held = {
        container: this,
        options,
        resolve,
        reject,
        forget: () => {
          held.delete(entry);
          signal?.removeEventListener("abort", onAbort);
        },
      };
      const onAbort = () => {
        entry.forget();
        reject(signal?.reason);
        update();
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      held.add(entry);
      update();
    });
  };

  view.addEventListener(EVENT_RELEASE, () => {
    for (const entry of [...held]) {
      entry.forget();
      get.call(entry.container, entry.options).then(entry.resolve, entry.reject);
    }
    update();
  });
}
