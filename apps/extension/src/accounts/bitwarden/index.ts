// Wires a BitwardenAccount into the browser: its storage (on disk, and in memory for the unlocked
// key), this install's device id, and Argon2id for accounts that use it.

import { BitwardenClient, type Region } from "@app/bitwarden";
import { argon2id } from "hash-wasm";
import { BITWARDEN_CLIENT_VERSION, DISPLAY_NAME } from "../../config.ts";
import { BitwardenAccount, type BitwardenRecord, type UnlockedKey } from "./account.ts";

export { BITWARDEN_PROVIDER, BitwardenAccount } from "./account.ts";

/** The id Bitwarden lists this browser by under the account's devices, made once per install. */
const DEVICE_ID = "bitwardenDeviceId";

async function deviceId(): Promise<string> {
  const stored = (await browser.storage.local.get(DEVICE_ID))[DEVICE_ID];
  if (typeof stored === "string") return stored;
  const id = crypto.randomUUID();
  await browser.storage.local.set({ [DEVICE_ID]: id });
  return id;
}

const argon2 = async (input: {
  password: Uint8Array;
  salt: Uint8Array;
  iterations: number;
  memoryKiB: number;
  parallelism: number;
}) =>
  new Uint8Array(
    await argon2id({
      password: input.password,
      salt: input.salt,
      iterations: input.iterations,
      memorySize: input.memoryKiB,
      parallelism: input.parallelism,
      hashLength: 32,
      outputType: "binary",
    }),
  );

export function bitwardenClient(region: Region): Promise<BitwardenClient> {
  return deviceId().then(
    (id) =>
      new BitwardenClient({
        region,
        deviceId: id,
        // Bitwarden's device types: 2 for a Chrome extension, 3 for Firefox
        deviceType: import.meta.env.FIREFOX ? 3 : 2,
        deviceName: DISPLAY_NAME,
        clientVersion: BITWARDEN_CLIENT_VERSION,
        argon2,
      }),
  );
}

export function createBitwardenAccount(id: string, lockAfterMinutes: () => Promise<number>): BitwardenAccount {
  const recordKey = `bitwarden:${id}`;
  const sessionKey = `bitwardenKey:${id}`;
  return new BitwardenAccount(id, {
    client: bitwardenClient,
    lockAfterMinutes,
    argon2,
    openTab: async (url) => {
      await browser.tabs.create({ url });
    },
    store: {
      load: async () => (await browser.storage.local.get(recordKey))[recordKey] as BitwardenRecord | undefined,
      save: (record) => browser.storage.local.set({ [recordKey]: record }),
      loadKey: async () => (await browser.storage.session.get(sessionKey))[sessionKey] as UnlockedKey | undefined,
      saveKey: (key) => browser.storage.session.set({ [sessionKey]: key }),
      clearKey: () => browser.storage.session.remove(sessionKey),
      clear: async () => {
        await browser.storage.session.remove(sessionKey);
        await browser.storage.local.remove(recordKey);
      },
    },
  });
}
