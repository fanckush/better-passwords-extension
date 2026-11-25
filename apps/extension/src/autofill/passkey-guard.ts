// Keeps the browser's own passkey suggestions out of login fields, where they show next to our
// inline menu (issue #29). Sites ask for them with a "conditional" WebAuthn request. We tell sites
// it isn't available, and we hold any such request until the site aborts it. Passkeys still work
// through the site's own passkey button, which makes a normal request and opens the browser's
// passkey window.

/** The static members of PublicKeyCredential we change; not all browsers have them. */
interface PasskeyApi {
  isConditionalMediationAvailable?: () => Promise<boolean>;
  getClientCapabilities?: () => Promise<Record<string, boolean>>;
}

/** Must run in the page's own JavaScript world, before the site's scripts. */
export function guardConditionalPasskeys(view: Window & typeof globalThis = window): void {
  const credentials = view.CredentialsContainer?.prototype;
  const publicKey = view.PublicKeyCredential as unknown as PasskeyApi | undefined;
  if (!credentials || !publicKey) return;

  // sites that check first usually show their own passkey button instead
  if (publicKey.isConditionalMediationAvailable) {
    publicKey.isConditionalMediationAvailable = () => Promise.resolve(false);
  }
  const capabilities = publicKey.getClientCapabilities;
  if (capabilities) {
    publicKey.getClientCapabilities = () =>
      capabilities.call(publicKey).then((found) => ({ ...found, conditionalGet: false }));
  }

  const get = credentials.get;
  credentials.get = function (this: CredentialsContainer, options?: CredentialRequestOptions) {
    if (options?.mediation !== "conditional" || !options.publicKey) return get.call(this, options);
    // as if the user never picked a passkey: it ends only when the site aborts it
    const signal = options.signal;
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise<Credential | null>((_, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  };
}
