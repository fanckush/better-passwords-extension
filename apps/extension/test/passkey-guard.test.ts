import { describe, expect, it, vi } from "vitest";
import { guardConditionalPasskeys } from "../src/autofill/passkey-guard.ts";

/** A window with just the WebAuthn parts the guard changes. */
function fakeWindow() {
  const nativeGet = vi.fn(async () => ({ id: "from-browser" }) as unknown as Credential);
  class CredentialsContainer {}
  // the guard patches the prototype, where the browser keeps get
  (CredentialsContainer.prototype as unknown as { get: unknown }).get = nativeGet;
  const PublicKeyCredential = {
    isConditionalMediationAvailable: async () => true,
    getClientCapabilities: async () => ({ conditionalGet: true, passkeyPlatformAuthenticator: true }),
  };
  const view = { CredentialsContainer, PublicKeyCredential } as unknown as Window & typeof globalThis;
  const credentials = Object.create(CredentialsContainer.prototype) as globalThis.CredentialsContainer;
  return { view, credentials, nativeGet, PublicKeyCredential };
}

const publicKey = { challenge: new Uint8Array(32) };

describe("guardConditionalPasskeys", () => {
  it("says conditional passkey requests aren't available", async () => {
    const { view, PublicKeyCredential } = fakeWindow();
    guardConditionalPasskeys(view);
    await expect(PublicKeyCredential.isConditionalMediationAvailable()).resolves.toBe(false);
    await expect(PublicKeyCredential.getClientCapabilities()).resolves.toEqual({
      conditionalGet: false,
      passkeyPlatformAuthenticator: true,
    });
  });

  it("holds a conditional passkey request until the site aborts it", async () => {
    const { view, credentials, nativeGet } = fakeWindow();
    guardConditionalPasskeys(view);
    const abort = new AbortController();
    const request = credentials.get({ mediation: "conditional", publicKey, signal: abort.signal });
    let settled = false;
    request.catch(() => {}).finally(() => (settled = true));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);
    abort.abort(new DOMException("moved on", "AbortError"));
    await expect(request).rejects.toThrow("moved on");
    expect(nativeGet).not.toHaveBeenCalled();
  });

  it("rejects at once when the signal is already aborted", async () => {
    const { view, credentials } = fakeWindow();
    guardConditionalPasskeys(view);
    const signal = AbortSignal.abort(new DOMException("too late", "AbortError"));
    await expect(credentials.get({ mediation: "conditional", publicKey, signal })).rejects.toThrow("too late");
  });

  it("passes other requests to the browser", async () => {
    const { view, credentials, nativeGet } = fakeWindow();
    guardConditionalPasskeys(view);
    // the site's own passkey button, and a conditional request that isn't for a passkey
    await expect(credentials.get({ publicKey })).resolves.toEqual({ id: "from-browser" });
    await credentials.get({ mediation: "conditional", password: true } as CredentialRequestOptions);
    expect(nativeGet).toHaveBeenCalledTimes(2);
    expect(nativeGet.mock.contexts[0]).toBe(credentials);
  });

  it("does nothing without WebAuthn", () => {
    expect(() => guardConditionalPasskeys({} as Window & typeof globalThis)).not.toThrow();
  });
});
