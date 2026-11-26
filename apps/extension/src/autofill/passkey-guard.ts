// Keeps the browser's own passkey list out of login fields, where it shows over our inline menu
// (issue #29). Sites ask for that list with a "conditional" WebAuthn request. While the guard is on,
// we hold any such request, so the browser shows nothing. The menu can then "show the browser's
// passkey list" once: held requests go to the browser, and later requests are held again. The site's
// own passkey button makes a normal request, which is never held.
//
// Page-side state is shared with the isolated content script through the page's DOM only:
// - ATTRIBUTE_GUARD="off" turns the guard off (set at document_start from the setting);
// - ATTRIBUTE_HELD="true" while a request is held, with EVENT_HELD dispatched when that changes;
// - EVENT_RELEASE, dispatched by the content script, shows the browser's list once.

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
  // after "Show" the page works as with the setting off, until it reloads
  let released = false;
  // checked at call time: the attribute is set a moment after the page starts, before it asks
  const guarding = () => !released && root()?.getAttribute(ATTRIBUTE_GUARD) !== "off";

  const update = () => {
    root()?.setAttribute(ATTRIBUTE_HELD, held.size > 0 ? "true" : "false");
    view.dispatchEvent(new Event(EVENT_HELD));
  };

  // The browser's answer stays as it is. Sites that check it first (GitHub does) then still send
  // their conditional request, and that request is held below. Answering "no" here would stop them
  // from sending it at all, so there would be nothing to show.

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
      console.debug("[BP passkey] held a conditional request, signal aborted:", signal?.aborted);
      update();
    });
  };

  // once: held requests go to the browser (the site gets its answer); with none held, the browser's
  // list opens for a fresh request. Requests after that are held again.
  view.addEventListener(EVENT_RELEASE, () => {
    console.debug(
      "[BP passkey] release: held",
      held.size,
      "focus",
      view.document.activeElement?.tagName,
      "userActivation",
      navigator.userActivation?.isActive,
    );
    released = true;
    if (held.size === 0) {
      const challenge = crypto.getRandomValues(new Uint8Array(32));
      // the real container: the prototype can't make a request ("Illegal invocation")
      get.call(navigator.credentials, { mediation: "conditional", publicKey: { challenge } }).then(
        (r) => console.debug("[BP passkey] fresh request resolved", r?.id),
        (e) => console.debug("[BP passkey] fresh request rejected", e?.name, e?.message),
      );
      return;
    }
    for (const entry of [...held]) {
      entry.forget();
      console.debug("[BP passkey] replay, signal aborted:", entry.options.signal?.aborted);
      get.call(entry.container, entry.options).then(
        (r) => {
          console.debug("[BP passkey] replay resolved", r?.id);
          entry.resolve(r);
        },
        (e) => {
          console.debug("[BP passkey] replay rejected", e?.name, e?.message);
          entry.reject(e);
        },
      );
    }
    update();
  });
}
