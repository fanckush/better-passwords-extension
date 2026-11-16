import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  isGone,
  isUsernameInput,
  isUserSubmit,
  sentLogin,
  submittedScope,
  watchUntilGone,
} from "../src/autofill/submission.ts";

beforeEach(() => {
  // happy-dom has no layout; treat everything as visible unless marked hidden
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const hidden = this.closest("[data-hidden]");
    return { width: hidden ? 0 : 200, height: hidden ? 0 : 24 } as DOMRect;
  });
});

const $ = <T extends Element>(selector: string) => document.querySelector(selector) as T;

describe("watchUntilGone", () => {
  it("reports when the field leaves the page", async () => {
    document.body.innerHTML = `<div id="dialog"><input id="p" type="password"></div>`;
    const onGone = vi.fn();
    watchUntilGone($<HTMLInputElement>("#p"), onGone, 5);
    $("#dialog").remove();
    await vi.waitFor(() => expect(onGone).toHaveBeenCalledOnce());
  });

  it("reports when the field is hidden", async () => {
    document.body.innerHTML = `<div id="step"><input id="p" type="password"></div>`;
    const onGone = vi.fn();
    watchUntilGone($<HTMLInputElement>("#p"), onGone, 5);
    $("#step").setAttribute("data-hidden", "");
    await vi.waitFor(() => expect(onGone).toHaveBeenCalledOnce());
  });

  it("stays quiet while the field is shown, and can be stopped", async () => {
    document.body.innerHTML = `<input id="p" type="password">`;
    const field = $<HTMLInputElement>("#p");
    const onGone = vi.fn();
    const stop = watchUntilGone(field, onGone, 5);
    await new Promise((r) => setTimeout(r, 30));
    expect(onGone).not.toHaveBeenCalled();
    stop();
    field.remove();
    await new Promise((r) => setTimeout(r, 30));
    expect(onGone).not.toHaveBeenCalled();
    expect(isGone(field)).toBe(true);
  });
});

describe("isUsernameInput", () => {
  it.each([
    [`<input id="f" type="email">`, true],
    [`<input id="f" autocomplete="username">`, true],
    [`<input id="f" name="user_login">`, true],
    [`<input id="f" name="first_name">`, false],
    [`<input id="f" type="search" name="email">`, false],
  ])("%s → %s", (html, expected) => {
    document.body.innerHTML = html;
    expect(isUsernameInput($("#f"))).toBe(expected);
  });
});

describe("sentLogin", () => {
  const typeInto = (selector: string, value: string) => {
    $<HTMLInputElement>(selector).value = value;
  };

  it("takes the password and the username of a sign-in form", () => {
    document.body.innerHTML = `<form><input id="u" autocomplete="username"><input id="p" type="password"></form>`;
    typeInto("#u", " jane@example.com ");
    typeInto("#p", "hunter2");
    expect(sentLogin($("form"))).toEqual({ field: $("#p"), username: "jane@example.com", password: "hunter2" });
  });

  it("takes the new password when changing it", () => {
    document.body.innerHTML = `<form>
      <input id="old" type="password" autocomplete="current-password">
      <input id="new" type="password" autocomplete="new-password">
      <input id="again" type="password" autocomplete="new-password"></form>`;
    typeInto("#old", "old-one");
    typeInto("#new", "new-one");
    typeInto("#again", "new-one");
    expect(sentLogin($("form"))?.password).toBe("new-one");
  });

  it("uses the username from an earlier step when the form has none", () => {
    document.body.innerHTML = `<form><input id="p" type="password"></form>`;
    typeInto("#p", "hunter2");
    expect(sentLogin($("form"), "steps@example.com")?.username).toBe("steps@example.com");
  });

  it("ignores empty and hidden password fields", () => {
    document.body.innerHTML = `<form><input id="p" type="password"><div data-hidden><input id="h" type="password"></div></form>`;
    typeInto("#h", "autofilled-by-someone");
    expect(sentLogin($("form"))).toBeUndefined();
  });
});

describe("submittedScope", () => {
  it("is the form of a clicked button", () => {
    document.body.innerHTML = `<form><input type="password"><button><span id="label">Sign in</span></button></form>`;
    expect(submittedScope($("#label"))).toBe($("form"));
  });

  it("is the part of a formless page around the password field", () => {
    document.body.innerHTML = `<div id="banner"><button id="ok">OK</button></div>
      <div id="signin"><input type="password"><div id="go" role="button">Sign in</div></div>`;
    expect(submittedScope($("#go"))).toBe($("#signin"));
    // a button elsewhere on the page sends no login
    expect(submittedScope($("#ok"))).toBeUndefined();
  });

  it("is the form of a field Enter was pressed in, and nothing for clicks on plain text", () => {
    document.body.innerHTML = `<form><input id="p" type="password"><p id="text">Forgot?</p></form>`;
    expect(submittedScope($("#p"), "Enter")).toBe($("form"));
    expect(submittedScope($("#text"))).toBeUndefined();
  });
});

describe("isUserSubmit", () => {
  it("accepts a form the user sent", () => {
    expect(isUserSubmit({ isTrusted: true }, { isActive: false })).toBe(true);
  });

  it("accepts a script's submit in answer to the user", () => {
    expect(isUserSubmit({ isTrusted: false }, { isActive: true })).toBe(true);
  });

  it("ignores a script's submit with no user action behind it", () => {
    expect(isUserSubmit({ isTrusted: false }, { isActive: false })).toBe(false);
  });

  it("keeps accepting submits where the browser can't tell", () => {
    expect(isUserSubmit({ isTrusted: false }, undefined)).toBe(true);
  });
});
