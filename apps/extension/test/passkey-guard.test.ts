import { describe, expect, it, vi } from "vitest";
import {
  ATTRIBUTE_GUARD,
  ATTRIBUTE_HELD,
  EVENT_HELD,
  EVENT_RELEASE,
  guardConditionalPasskeys,
} from "../src/autofill/passkey-guard.ts";

/** A window with the WebAuthn parts the guard changes, a document root, and event dispatch. */
function fakeWindow() {
  const nativeGet = vi.fn(async (options?: CredentialRequestOptions) => {
    return { id: "from-browser", mediation: options?.mediation } as unknown as Credential;
  });
  class CredentialsContainer {}
  // the guard patches the prototype, where the browser keeps get
  (CredentialsContainer.prototype as unknown as { get: unknown }).get = nativeGet;
  const PublicKeyCredential = {
    isConditionalMediationAvailable: vi.fn(async () => true),
    getClientCapabilities: async () => ({ conditionalGet: true, passkeyPlatformAuthenticator: true }),
  };
  const events = new EventTarget();
  const view = Object.assign(events, {
    CredentialsContainer,
    PublicKeyCredential,
    document: { documentElement: document.createElement("html") },
  }) as unknown as Window & typeof globalThis;
  const credentials = Object.create(CredentialsContainer.prototype) as globalThis.CredentialsContainer;
  const root = (view as unknown as { document: Document }).document.documentElement;
  return { view, credentials, nativeGet, PublicKeyCredential, root, events };
}

const publicKey = { challenge: new Uint8Array(32) };
const conditional = (signal?: AbortSignal): CredentialRequestOptions => ({
  mediation: "conditional",
  publicKey,
  ...(signal ? { signal } : {}),
});

/** Whether the promise has settled, after a short wait. */
async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  promise.then(
    () => (done = true),
    () => (done = true),
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  return done;
}

describe("guardConditionalPasskeys", () => {
  it("keeps the browser's own answers, so sites still send their conditional request", async () => {
    const { view, PublicKeyCredential } = fakeWindow();
    guardConditionalPasskeys(view);
    await expect(PublicKeyCredential.isConditionalMediationAvailable()).resolves.toBe(true);
    await expect(PublicKeyCredential.getClientCapabilities()).resolves.toEqual({
      conditionalGet: true,
      passkeyPlatformAuthenticator: true,
    });
  });

  it("holds a conditional passkey request until the site aborts it", async () => {
    const { view, credentials, nativeGet, root } = fakeWindow();
    guardConditionalPasskeys(view);
    const abort = new AbortController();
    const request = credentials.get(conditional(abort.signal));
    expect(await settled(request)).toBe(false);
    expect(root.getAttribute(ATTRIBUTE_HELD)).toBe("true");
    abort.abort(new DOMException("moved on", "AbortError"));
    await expect(request).rejects.toThrow("moved on");
    expect(nativeGet).not.toHaveBeenCalled();
    expect(root.getAttribute(ATTRIBUTE_HELD)).toBe("false");
  });

  it("rejects at once when the signal is already aborted", async () => {
    const { view, credentials } = fakeWindow();
    guardConditionalPasskeys(view);
    const signal = AbortSignal.abort(new DOMException("too late", "AbortError"));
    await expect(credentials.get(conditional(signal))).rejects.toThrow("too late");
  });

  it("passes other requests to the browser", async () => {
    const { view, credentials, nativeGet } = fakeWindow();
    guardConditionalPasskeys(view);
    // the site's own passkey button, and a conditional request that isn't for a passkey
    await expect(credentials.get({ publicKey })).resolves.toEqual({ id: "from-browser", mediation: undefined });
    await credentials.get({ mediation: "conditional", password: true } as CredentialRequestOptions);
    expect(nativeGet).toHaveBeenCalledTimes(2);
    expect(nativeGet.mock.contexts[0]).toBe(credentials);
  });

  it("releases held requests to the browser once, and later requests are held again", async () => {
    const { view, credentials, nativeGet, root, events } = fakeWindow();
    guardConditionalPasskeys(view);
    const held = credentials.get(conditional());
    expect(await settled(held)).toBe(false);

    events.dispatchEvent(new Event(EVENT_RELEASE));
    await expect(held).resolves.toEqual({ id: "from-browser", mediation: "conditional" });
    expect(root.getAttribute(ATTRIBUTE_HELD)).toBe("false");
    expect(nativeGet).toHaveBeenCalledTimes(1);
    // the next request is held again
    expect(await settled(credentials.get(conditional()))).toBe(false);
    expect(root.getAttribute(ATTRIBUTE_HELD)).toBe("true");
  });

  it("with nothing held, shows the browser's list once with a fresh request", async () => {
    const { view, credentials, nativeGet, events } = fakeWindow();
    guardConditionalPasskeys(view);
    events.dispatchEvent(new Event(EVENT_RELEASE));
    expect(nativeGet).toHaveBeenCalledTimes(1);
    const [options] = nativeGet.mock.calls[0] as unknown as [CredentialRequestOptions];
    expect(options.mediation).toBe("conditional");
    expect(options.publicKey?.challenge).toBeInstanceOf(Uint8Array);
    // the page's next request is still held
    expect(await settled(credentials.get(conditional()))).toBe(false);
  });

  it("passes the browser's failure of a released request to the site", async () => {
    const { view, credentials, nativeGet, events } = fakeWindow();
    nativeGet.mockRejectedValueOnce(new DOMException("cancelled", "NotAllowedError"));
    guardConditionalPasskeys(view);
    const held = credentials.get(conditional());
    events.dispatchEvent(new Event(EVENT_RELEASE));
    await expect(held).rejects.toThrow("cancelled");
  });

  it("announces held requests on the document and through an event", async () => {
    const { view, credentials, root, events } = fakeWindow();
    guardConditionalPasskeys(view);
    const seen: string[] = [];
    events.addEventListener(EVENT_HELD, () => seen.push(root.getAttribute(ATTRIBUTE_HELD) ?? ""));
    const abort = new AbortController();
    credentials.get(conditional(abort.signal)).catch(() => {});
    abort.abort();
    expect(seen).toEqual(["true", "false"]);
  });

  it("does nothing while the page has the guard turned off", async () => {
    const { view, credentials, nativeGet, PublicKeyCredential, root } = fakeWindow();
    root.setAttribute(ATTRIBUTE_GUARD, "off");
    guardConditionalPasskeys(view);
    await expect(PublicKeyCredential.isConditionalMediationAvailable()).resolves.toBe(true);
    await credentials.get(conditional());
    expect(nativeGet).toHaveBeenCalledTimes(1);
    expect(root.getAttribute(ATTRIBUTE_HELD)).toBeNull();
  });

  it("does nothing without WebAuthn", () => {
    expect(() => guardConditionalPasskeys({} as Window & typeof globalThis)).not.toThrow();
  });
});
