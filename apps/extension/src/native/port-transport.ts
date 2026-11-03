import type { HelperMessage, Transport } from "@app/protocol";

/** Transport over `runtime.connectNative`. Opening the port launches the native host. */
export class PortTransport implements Transport {
  readonly #port: Browser.runtime.Port;

  constructor(hostName: string) {
    this.#port = browser.runtime.connectNative(hostName);
  }

  send(message: unknown): void {
    this.#port.postMessage(message);
  }

  onMessage(listener: (message: HelperMessage) => void): void {
    this.#port.onMessage.addListener((message: unknown) => listener(message as HelperMessage));
  }

  onClose(listener: (error?: string) => void): void {
    // Firefox puts the reason on the port, Chromium in lastError
    this.#port.onDisconnect.addListener((port) =>
      listener((port as { error?: { message?: string } }).error?.message ?? browser.runtime.lastError?.message),
    );
  }

  close(): void {
    this.#port.disconnect();
  }
}
