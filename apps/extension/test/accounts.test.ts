import { FakeHelper, MemoryTransport } from "@app/fake-helper";
import { describe, expect, it } from "vitest";
import { AppleAccount } from "../src/accounts/apple/account.ts";
import { Accounts, type AccountsStore, itemRef, parseRef, type StoredAccount } from "../src/accounts/registry.ts";
import type { AccountSettings } from "../src/accounts/types.ts";
import { MemoryAccount } from "./support/memory-account.ts";

const DEFAULTS: AccountSettings = { lockOnScreenLock: false, touchId: true };

type MemoryStore = AccountsStore & { saved: StoredAccount[] | undefined };

function memoryStore(initial?: StoredAccount[], legacy: Partial<AccountSettings> = {}): MemoryStore {
  const store: MemoryStore = {
    saved: initial,
    load: async () => store.saved,
    save: async (accounts) => {
      store.saved = accounts;
    },
    legacy: async () => legacy,
  };
  return store;
}

function twoAccounts() {
  const personal = new MemoryAccount("personal", "Personal", [
    { id: "p1", hostname: "example.com", username: "alice", password: "alice-home" },
  ]);
  const work = new MemoryAccount("work", "Work", [
    { id: "w1", hostname: "example.com", username: "alice", password: "alice-work" },
    { id: "w2", hostname: "example.com", username: "ops", password: "ops-pw" },
  ]);
  const accounts = new Accounts(
    [
      { account: personal, defaults: async () => DEFAULTS },
      { account: work, defaults: async () => DEFAULTS },
    ],
    memoryStore(),
  );
  return { personal, work, accounts };
}

describe("item refs", () => {
  it("round-trip the account and the item's id", () => {
    expect(parseRef(itemRef("work", "w1"))).toEqual({ account: "work", id: "w1" });
  });

  it("refuse anything else", () => {
    expect(() => parseRef("alice")).toThrow("no longer saved");
    expect(() => parseRef(JSON.stringify(["work", 1]))).toThrow("no longer saved");
  });
});

describe("Accounts", () => {
  it("refuses to list logins while every account is locked", async () => {
    const { accounts } = twoAccounts();
    await expect(accounts.logins("example.com")).rejects.toMatchObject({ code: "locked" });
  });

  it("lists only the unlocked accounts' logins", async () => {
    const { accounts, work } = twoAccounts();
    await work.unlock.unlock("secret");
    const logins = await accounts.logins("example.com");
    expect(logins.map((l) => [l.account, l.username])).toEqual([
      ["work", "alice"],
      ["work", "ops"],
    ]);
  });

  it("merges logins of several accounts, the same username apart by ref", async () => {
    const { accounts, personal, work } = twoAccounts();
    await personal.unlock.unlock("secret");
    await work.unlock.unlock("secret");
    const logins = await accounts.logins("example.com");
    expect(logins).toHaveLength(3);
    const alices = logins.filter((l) => l.username === "alice");
    expect(new Set(alices.map((l) => l.ref)).size).toBe(2);
  });

  it("fills each login from the account it came from", async () => {
    const { accounts, personal, work } = twoAccounts();
    await personal.unlock.unlock("secret");
    await work.unlock.unlock("secret");
    const logins = await accounts.logins("example.com");
    const tab = { tabId: 1 };
    const passwords = await Promise.all(logins.map((l) => accounts.credential("example.com", l.ref, tab)));
    expect(passwords.map((c) => c.password).sort()).toEqual(["alice-home", "alice-work", "ops-pw"]);
  });

  it("won't fill from an account locked since it was listed", async () => {
    const { accounts, work } = twoAccounts();
    await work.unlock.unlock("secret");
    const [login] = await accounts.logins("example.com");
    work.lock();
    await expect(accounts.credential("example.com", login?.ref ?? "", { tabId: 1 })).rejects.toMatchObject({
      code: "locked",
    });
  });

  it("leaves out an account that fails, unless all do", async () => {
    const { accounts, personal, work } = twoAccounts();
    await personal.unlock.unlock("secret");
    await work.unlock.unlock("secret");
    work.logins = async () => {
      throw new Error("offline");
    };
    expect((await accounts.logins("example.com")).map((l) => l.account)).toEqual(["personal"]);
    personal.logins = async () => {
      throw new Error("also offline");
    };
    await expect(accounts.logins("example.com")).rejects.toThrow();
  });

  it("saves new logins to one account, an unlocked one", async () => {
    const { accounts, personal, work } = twoAccounts();
    expect(() => accounts.saveTarget("example.com")).toThrow("unlock");
    await work.unlock.unlock("secret");
    const target = accounts.saveTarget("example.com");
    expect(target).toBe(work);
    await target.save({ hostname: "example.com", username: "bob", password: "pw" }, { tabId: 1 });
    expect(work.saved).toHaveLength(1);
    expect(personal.saved).toHaveLength(0);
    expect(await accounts.usernames("example.com", work)).toContain("bob");
  });

  it("locks one account or all of them", async () => {
    const { accounts, personal, work } = twoAccounts();
    await personal.unlock.unlock("secret");
    await work.unlock.unlock("secret");
    accounts.lock("work");
    expect([personal.isUnlocked, work.isUnlocked]).toEqual([true, false]);
    expect(accounts.anyUnlocked).toBe(true);
    accounts.lock();
    expect(accounts.anyUnlocked).toBe(false);
  });

  it("tells which account changed", async () => {
    const { accounts, work } = twoAccounts();
    const seen: [string, string][] = [];
    accounts.onChange((account, status) => seen.push([account.id, status.state]));
    await work.unlock.unlock("secret");
    expect(seen).toEqual([["work", "unlocked"]]);
  });

  it("finds no account that unlocks with a code among password accounts", () => {
    const { accounts } = twoAccounts();
    expect(() => accounts.pairingCode()).toThrow("code");
  });
});

describe("Accounts settings", () => {
  it("starts each account from its defaults, then the user's changes", async () => {
    const store = memoryStore([]);
    const account = new MemoryAccount("work", "Work", []);
    const accounts = new Accounts([{ account, defaults: async () => DEFAULTS }], store);
    expect(await accounts.settings("work")).toEqual(DEFAULTS);
    expect(await accounts.setSettings("work", { lockOnScreenLock: true })).toEqual({
      ...DEFAULTS,
      lockOnScreenLock: true,
    });
    expect(store.saved).toEqual([{ id: "work", provider: "memory", settings: { lockOnScreenLock: true } }]);
  });

  it("moves the options set before accounts existed to the first account", async () => {
    const store = memoryStore(undefined, { touchId: false });
    const account = new MemoryAccount("apple", "Apple Passwords", []);
    const accounts = new Accounts([{ account, defaults: async () => DEFAULTS }], store);
    expect(await accounts.settings("apple")).toEqual({ ...DEFAULTS, touchId: false });
    expect(store.saved).toEqual([{ id: "apple", provider: "memory", settings: { touchId: false } }]);
  });

  it("keeps what's stored once accounts exist", async () => {
    const store = memoryStore([{ id: "apple", provider: "memory", settings: { lockOnScreenLock: true } }], {
      touchId: false,
    });
    const account = new MemoryAccount("apple", "Apple Passwords", []);
    const accounts = new Accounts([{ account, defaults: async () => DEFAULTS }], store);
    expect(await accounts.settings("apple")).toEqual({ ...DEFAULTS, lockOnScreenLock: true });
  });

  it("describes each account for pages", async () => {
    const { accounts } = twoAccounts();
    const views = await accounts.views();
    expect(views.map((v) => [v.id, v.state, v.unlock.kind])).toEqual([
      ["personal", "locked", "password"],
      ["work", "locked", "password"],
    ]);
  });
});

describe("AppleAccount", () => {
  const vault = [{ hostname: "example.com", username: "alice", password: "pw" }];

  function apple(touchId?: { code: () => string }) {
    const helper = new FakeHelper({ vault });
    const account = new AppleAccount("apple", {
      openTransport: () => new MemoryTransport(helper),
      ...(touchId ? { readCode: async () => touchId.code(), touchIdReady: async () => true } : {}),
    });
    return { helper, account };
  }

  it("speaks of its states in an account's words", async () => {
    const { helper, account } = apple();
    expect(account.status.state).toBe("offline");
    await account.unlock.requestCode(false);
    expect(account.status.state).toBe("unlocking");
    await account.unlock.verifyCode(helper.currentCode ?? "");
    expect(account.status.state).toBe("unlocked");
    account.lock();
    expect(account.status.state).toBe("offline");
  });

  it("names logins by username, and fills them through the registry", async () => {
    const { helper, account } = apple();
    const accounts = new Accounts([{ account, defaults: async () => DEFAULTS }], memoryStore());
    await account.unlock.requestCode(false);
    await account.unlock.verifyCode(helper.currentCode ?? "");
    const [login] = await accounts.logins("example.com");
    expect(login).toMatchObject({ account: "apple", username: "alice" });
    const credential = await accounts.credential("example.com", login?.ref ?? "", { tabId: 1 });
    expect(credential).toEqual({ username: "alice", password: "pw" });
  });

  it("unlocks with the code the companion app reads after Touch ID", async () => {
    const holder: { helper?: FakeHelper } = {};
    const { helper, account } = apple({ code: () => holder.helper?.currentCode ?? "" });
    holder.helper = helper;
    await account.unlock.unlockWithTouchId?.();
    expect(account.isUnlocked).toBe(true);
  });

  it("shows a fresh code when the companion app read a wrong one", async () => {
    const { helper, account } = apple({ code: () => "000000" });
    await expect(account.unlock.unlockWithTouchId?.()).rejects.toThrow();
    expect(account.isUnlocked).toBe(false);
    expect(helper.currentCode).toBeDefined();
  });

  it("reports Touch ID only when the user wants it and the app is ready", async () => {
    const { account } = apple({ code: () => "" });
    const store = memoryStore();
    const accounts = new Accounts([{ account, defaults: async () => DEFAULTS }], store);
    const [view] = await accounts.views();
    expect(view?.unlock).toEqual({ kind: "pairing-code", digits: 6, touchId: true });
    await accounts.setSettings("apple", { touchId: false });
    const [off] = await accounts.views();
    expect(off?.unlock).toEqual({ kind: "pairing-code", digits: 6 });
  });
});
