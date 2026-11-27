import { FakeHelper, MemoryTransport } from "@app/fake-helper";
import { describe, expect, it } from "vitest";
import { AppleAccount } from "../src/accounts/apple/account.ts";
import { Accounts, type AccountsStore, itemRef, parseRef, type StoredAccount } from "../src/accounts/registry.ts";
import type { AccountSettings } from "../src/accounts/types.ts";
import { MemoryAccount } from "./support/memory-account.ts";

const DEFAULTS: AccountSettings = { lockOnScreenLock: false, touchId: true, lockAfterMinutes: 0 };
const PAGE = new URL("https://example.com/login");

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
    await expect(accounts.logins(PAGE)).rejects.toMatchObject({ code: "locked" });
  });

  it("lists only the unlocked accounts' logins", async () => {
    const { accounts, work } = twoAccounts();
    await work.unlock.unlock("secret");
    const logins = await accounts.logins(PAGE);
    expect(logins.map((l) => [l.account, l.username])).toEqual([
      ["work", "alice"],
      ["work", "ops"],
    ]);
  });

  it("merges logins of several accounts, the same username apart by ref", async () => {
    const { accounts, personal, work } = twoAccounts();
    await personal.unlock.unlock("secret");
    await work.unlock.unlock("secret");
    const logins = await accounts.logins(PAGE);
    expect(logins).toHaveLength(3);
    const alices = logins.filter((l) => l.username === "alice");
    expect(new Set(alices.map((l) => l.ref)).size).toBe(2);
  });

  it("fills each login from the account it came from", async () => {
    const { accounts, personal, work } = twoAccounts();
    await personal.unlock.unlock("secret");
    await work.unlock.unlock("secret");
    const logins = await accounts.logins(PAGE);
    const tab = { tabId: 1 };
    const passwords = await Promise.all(logins.map((l) => accounts.credential(PAGE, l.ref, tab)));
    expect(passwords.map((c) => c.password).sort()).toEqual(["alice-home", "alice-work", "ops-pw"]);
  });

  it("won't fill from an account locked since it was listed", async () => {
    const { accounts, work } = twoAccounts();
    await work.unlock.unlock("secret");
    const [login] = await accounts.logins(PAGE);
    work.lock();
    await expect(accounts.credential(PAGE, login?.ref ?? "", { tabId: 1 })).rejects.toMatchObject({
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
    expect((await accounts.logins(PAGE)).map((l) => l.account)).toEqual(["personal"]);
    personal.logins = async () => {
      throw new Error("also offline");
    };
    await expect(accounts.logins(PAGE)).rejects.toThrow();
  });

  it("saves new logins to one account, an unlocked one", async () => {
    const { accounts, personal, work } = twoAccounts();
    await expect(accounts.saveTarget(PAGE)).rejects.toThrow("unlock");
    await work.unlock.unlock("secret");
    const target = await accounts.saveTarget(PAGE);
    expect(target).toBe(work);
    await target.save({ hostname: "example.com", username: "bob", password: "pw" }, { tabId: 1 });
    expect(work.saved).toHaveLength(1);
    expect(personal.saved).toHaveLength(0);
    expect(await accounts.usernames(PAGE, work)).toContain("bob");
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

describe("saving to the right account", () => {
  function chosen(saveTo: string | undefined) {
    const personal = new MemoryAccount("personal", "Personal", [
      { id: "p1", hostname: "example.com", username: "alice", password: "a" },
    ]);
    const work = new MemoryAccount("work", "Work", [
      { id: "w1", hostname: "example.com", username: "bob", password: "b" },
    ]);
    const accounts = new Accounts(
      [
        { account: personal, defaults: async () => DEFAULTS },
        { account: work, defaults: async () => DEFAULTS },
      ],
      memoryStore(),
      { saveTo: async () => saveTo },
    );
    return { accounts, personal, work };
  }

  it("saves a new password to the account that has the login", async () => {
    const { accounts, personal, work } = chosen("personal");
    await personal.unlock.unlock("secret");
    await work.unlock.unlock("secret");
    expect(await accounts.saveTarget(PAGE, "BOB")).toBe(work);
    expect(await accounts.saveTarget(PAGE, "alice")).toBe(personal);
  });

  it("saves a new login to the account the user chose", async () => {
    const { accounts, work, personal } = chosen("work");
    await personal.unlock.unlock("secret");
    await work.unlock.unlock("secret");
    expect(await accounts.saveTarget(PAGE, "carol")).toBe(work);
    expect(await accounts.saveTarget(PAGE, "")).toBe(work);
  });

  it("asks to unlock the chosen account rather than saving elsewhere", async () => {
    const { accounts, personal } = chosen("work");
    await personal.unlock.unlock("secret");
    await expect(accounts.saveTarget(PAGE, "carol")).rejects.toThrow("Unlock Work");
    // an update still goes where the login is
    expect(await accounts.saveTarget(PAGE, "alice")).toBe(personal);
  });

  it("falls back to the first unlocked account when the chosen one is gone", async () => {
    const { accounts, personal } = chosen("removed");
    await personal.unlock.unlock("secret");
    expect(await accounts.saveTarget(PAGE, "carol")).toBe(personal);
  });
});

describe("a list of accounts", () => {
  const create = (stored: StoredAccount) =>
    stored.provider === "memory"
      ? { account: new MemoryAccount(stored.id, stored.id, []), defaults: async () => DEFAULTS }
      : undefined;

  it("starts a new install with the initial accounts, and keeps them", async () => {
    const store = memoryStore();
    const accounts = new Accounts([], store, { create, initial: [{ id: "first", provider: "memory" }] });
    expect((await accounts.views()).map((v) => v.id)).toEqual(["first"]);
    expect(store.saved).toEqual([{ id: "first", provider: "memory", settings: {} }]);
  });

  it("makes the stored accounts, leaving out providers it doesn't know", async () => {
    const store = memoryStore([
      { id: "a", provider: "memory", settings: { lockAfterMinutes: 5 } },
      { id: "b", provider: "from-the-future", settings: {} },
    ]);
    const accounts = new Accounts([], store, { create, initial: [{ id: "first", provider: "memory" }] });
    await accounts.ready;
    expect(accounts.all.map((a) => a.id)).toEqual(["a"]);
    expect((await accounts.settings("a")).lockAfterMinutes).toBe(5);
  });

  it("keeps an account added after the list was read", async () => {
    const store = memoryStore([{ id: "a", provider: "memory", settings: {} }]);
    const accounts = new Accounts([], store, { create });
    await accounts.views();
    await accounts.add({ account: new MemoryAccount("b", "B", []), defaults: async () => DEFAULTS });
    expect(store.saved?.map((s) => s.id)).toEqual(["a", "b"]);
    const restarted = new Accounts([], store, { create });
    await restarted.ready;
    expect(restarted.all.map((a) => a.id)).toEqual(["a", "b"]);
  });

  it("adds and removes accounts, telling listeners of added ones too", async () => {
    const store = memoryStore([]);
    const accounts = new Accounts([], store, { create });
    const seen: string[] = [];
    accounts.onChange((account, { state }) => seen.push(`${account.id}:${state}`));
    const added = new MemoryAccount("new", "New", [
      { id: "x", hostname: "example.com", username: "zed", password: "z" },
    ]);
    let removed = false;
    added.remove = async () => {
      removed = true;
    };
    await accounts.add({ account: added, defaults: async () => DEFAULTS });
    await expect(accounts.add({ account: added, defaults: async () => DEFAULTS })).rejects.toThrow("already");
    await added.unlock.unlock("secret");
    expect((await accounts.logins(PAGE)).map((l) => l.username)).toEqual(["zed"]);
    expect(store.saved).toEqual([{ id: "new", provider: "memory", settings: {} }]);

    await accounts.remove("new");
    expect(removed).toBe(true);
    expect(accounts.all).toEqual([]);
    expect(store.saved).toEqual([]);
    expect(seen).toEqual(["new:locked", "new:unlocked", "new:locked"]);
    await added.unlock.unlock("secret");
    expect(seen).toHaveLength(3); // not listened to any more
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
    const [login] = await accounts.logins(PAGE);
    expect(login).toMatchObject({ account: "apple", username: "alice" });
    const credential = await accounts.credential(PAGE, login?.ref ?? "", { tabId: 1 });
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
