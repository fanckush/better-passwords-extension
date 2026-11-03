#!/usr/bin/env bun
// Runs the fake helper as a native-messaging host (stdin/stdout), for end-to-end tests.
//
// Env: FAKE_HELPER_CODE  fixed pairing code (default 123456)
//      FAKE_HELPER_VAULT path to a JSON array of { hostname, username, password, totp? }
//      FAKE_HELPER_LOG   file to append a JSON line to for each request to open the Passwords app,
//                        each code shown, each password read, each save, and each listing or
//                        fill of verification codes
//      FAKE_HELPER_SAVE  "decline" answers every "Save password?" prompt with Don't Save
//      FAKE_HELPER_CAPABILITIES  JSON merged into the capabilities reply
//      FAKE_HELPER_NOW   fixed clock (ms since the epoch) for verification codes
//      FAKE_HELPER_CODES_NEED_AUTH  "1" asks for Touch ID before a verification code is filled

import { appendFileSync } from "node:fs";
import { Command, type HelperMessage } from "@app/protocol";
import { FakeHelper, type VaultEntry } from "./fake-helper.ts";
import { encodeFrame, FrameDecoder } from "./native-messaging.ts";

const vaultPath = process.env.FAKE_HELPER_VAULT;
const vault: VaultEntry[] = vaultPath ? await Bun.file(vaultPath).json() : [];
const helper = new FakeHelper({
  vault,
  code: process.env.FAKE_HELPER_CODE ?? "123456",
  declineSaves: process.env.FAKE_HELPER_SAVE === "decline",
  ...(process.env.FAKE_HELPER_CAPABILITIES ? { capabilities: JSON.parse(process.env.FAKE_HELPER_CAPABILITIES) } : {}),
  ...(process.env.FAKE_HELPER_NOW ? { now: () => Number(process.env.FAKE_HELPER_NOW) } : {}),
  requiresAuthenticationForCodes: process.env.FAKE_HELPER_CODES_NEED_AUTH === "1",
});
const decoder = new FrameDecoder();

const reader = Bun.stdin.stream().getReader();
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  for (const message of decoder.push(value)) {
    const logPath = process.env.FAKE_HELPER_LOG;
    const savedBefore = helper.saved.length;
    const codeReadsBefore = helper.oneTimeCodeReads.length;
    const codeFillsBefore = helper.oneTimeCodeFills.length;
    if (logPath && (message as HelperMessage).cmd === Command.LaunchPasswordsApp) {
      appendFileSync(
        logPath,
        `${JSON.stringify({ type: "launch", url: (message as HelperMessage).searchQueryURL ?? "" })}\n`,
      );
    }
    const msg = (message as HelperMessage).msg as { QID?: string } | undefined;
    if (logPath && (message as HelperMessage).cmd === Command.Handshake && msg?.QID === "m0") {
      appendFileSync(logPath, `${JSON.stringify({ type: "code" })}\n`);
    }
    if (logPath && (message as HelperMessage).cmd === Command.GetPasswordForLoginName) {
      appendFileSync(logPath, `${JSON.stringify({ type: "password-read" })}\n`);
    }
    for (const reply of await helper.handle(message as HelperMessage)) {
      await Bun.write(Bun.stdout, encodeFrame(reply));
    }
    if (logPath) {
      for (const save of helper.saved.slice(savedBefore)) {
        appendFileSync(logPath, `${JSON.stringify({ type: "save", ...save })}\n`);
      }
      for (const read of helper.oneTimeCodeReads.slice(codeReadsBefore)) {
        appendFileSync(logPath, `${JSON.stringify({ type: "code-list", ...read })}\n`);
      }
      for (const fill of helper.oneTimeCodeFills.slice(codeFillsBefore)) {
        appendFileSync(logPath, `${JSON.stringify({ type: "code-fill", ...fill })}\n`);
      }
    }
  }
}
