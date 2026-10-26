// Wire format of Apple's PasswordManagerBrowserExtensionHelper (native messaging, JSON).
// Command numbers match the helper's ExtensionCommand enum.

import { base64ToBytes, bytesToBase64, bytesToHex, bytesToUtf8, hexToBytes, utf8ToBytes } from "./bytes.ts";

export const Command = {
  End: 0,
  Handshake: 2,
  GetLoginNamesForUrl: 4,
  GetPasswordForLoginName: 5,
  /** Save a login ("maybe add"). Apple's extension sends it when a form is submitted. */
  SetPassword: 6,
  PasswordsDisabled: 9,
  ReloginNeeded: 10,
  LaunchPasswordsApp: 13,
  GetCapabilities: 14,
} as const;
export type Command = (typeof Command)[keyof typeof Command];

export const QueryId = {
  [Command.GetLoginNamesForUrl]: "CmdGetLoginNames4URL",
  [Command.GetPasswordForLoginName]: "CmdGetPassword4LoginName",
  [Command.SetPassword]: "CmdNewAccount4URL",
} as const;

/** PAKE message types inside the handshake. */
export const PakeMessage = {
  ClientKeyExchange: 0,
  ServerKeyExchange: 1,
  ClientVerification: 2,
  ServerVerification: 3,
} as const;

/** Only the RFC-verification flavour of the secret session is supported. */
export const SRP_WITH_RFC_VERIFICATION = 1;
export const PROTOCOL_VERSION = "1.0";

export const Action = { Search: 2, MaybeAdd: 4, GhostSearch: 5 } as const;

export const QueryStatus = {
  Success: 0,
  GenericError: 1,
  InvalidParam: 2,
  NoResults: 3,
  FailedToDelete: 4,
  FailedToUpdate: 5,
  InvalidMessageFormat: 6,
  DuplicateItem: 7,
  UnknownAction: 8,
  InvalidSession: 9,
} as const;

/** Handshake ErrCode for a wrong code in the server-verification message. */
export const PAKE_ERROR_INCORRECT_CODE = 1;

export interface Capabilities {
  shouldUseBase64?: boolean;
  secretSessionVersion?: number;
  canFillOneTimeCodes?: boolean;
  /** Whether a login can be saved before the user has typed a username. */
  canSaveAccountWithEmptyUserName?: boolean;
  operatingSystem?: { name: string; majorVersion: number; minorVersion: number };
  [key: string]: unknown;
  canOpenPasswordsAppToNewPasswordSheet?: boolean;
}

/** Any message from the helper. Replies echo the request's `cmd`; there is no correlation id. */
export interface HelperMessage {
  cmd: number;
  capabilities?: Capabilities;
  payload?: { PAKE?: string; SMSG?: string | SecureMessage; [key: string]: unknown };
  [key: string]: unknown;
}

export interface SecureMessage {
  TID: string;
  SDATA: string;
}

export interface ServerKeyExchange {
  TID: string;
  MSG: number;
  B: string;
  s: string;
  PROTO: number;
  ErrCode?: number;
}

export interface ServerVerification {
  TID: string;
  MSG: number;
  HAMK?: string;
  ErrCode?: number;
}

export interface LoginEntry {
  USR: string;
  sites?: string[];
  PWD?: string;
}

export interface QueryReply {
  STATUS: number;
  Entries?: LoginEntry[];
}

/** PAKE payloads travel as base64-encoded JSON. */
export const pake = {
  encode: (value: unknown) => bytesToBase64(utf8ToBytes(JSON.stringify(value))),
  decode: <T>(encoded: string) => JSON.parse(bytesToUtf8(base64ToBytes(encoded))) as T,
};

/**
 * Binary fields are base64 when the helper reports `shouldUseBase64` (current macOS),
 * otherwise hex, where some fields carry a "0x" prefix.
 */
export class BinaryCodec {
  constructor(readonly base64: boolean) {}

  encode(bytes: Uint8Array, hexPrefix = true): string {
    if (this.base64) return bytesToBase64(bytes);
    return `${hexPrefix ? "0x" : ""}${bytesToHex(bytes)}`;
  }

  decode(text: string): Uint8Array {
    return this.base64 ? base64ToBytes(text) : hexToBytes(text);
  }
}
