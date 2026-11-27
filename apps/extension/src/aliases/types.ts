// Email alias services: a fresh address for each site that forwards to the user's own. They work
// with any password manager (iCloud's Hide My Email with Bitwarden, say), so they're kept apart
// from accounts. Today there is one, iCloud's Hide My Email.

/**
 * "ready": usable, with the address made for this site before, if any; "signed-out": the user
 * isn't signed in to the service in this browser; "needs-upgrade": their plan has no aliases.
 */
export type AliasState =
  | { state: "ready"; address?: string }
  | { state: "signed-out" }
  | { state: "needs-upgrade" }
  | { state: "error"; message: string };

export interface AliasProvider {
  readonly id: string;
  readonly label: string;
  /** What it offers for a site, once the user has turned it on. */
  state(hostname: string): Promise<AliasState>;
  /** A new address, not yet reserved for anything. */
  generate(): Promise<string>;
  /** Reserves a generated address for a site, labeled with its name; returns the address to use. */
  reserve(address: string, hostname: string): Promise<string>;
  /** Remembers the address filled in on a site (one it had already, so not reserved again). */
  used?(address: string, hostname: string): void;
  /** Sets up (or takes down) what it needs while the user has it turned on. */
  setEnabled(on: boolean): Promise<void>;
}
