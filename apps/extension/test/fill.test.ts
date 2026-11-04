import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  asksForUsername,
  fillCredentials,
  fillEmail,
  fillNewPassword,
  fillOneTimeCode,
  newPasswordRules,
  usernameNear,
} from "../src/fill.ts";

const origin = window.location.origin;

beforeEach(() => {
  // happy-dom has no layout; treat everything as visible unless marked hidden
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const hidden = this.hasAttribute("data-hidden");
    return { width: hidden ? 0 : 200, height: hidden ? 0 : 24 } as DOMRect;
  });
});

function page(html: string) {
  document.body.innerHTML = html;
}

const value = (selector: string) => (document.querySelector(selector) as HTMLInputElement).value;

describe("fillCredentials", () => {
  it("fills the username and password of a login form", () => {
    page(`<form>
      <input id="search" type="search">
      <input id="user" type="email">
      <input id="pass" type="password">
    </form>`);
    expect(fillCredentials(origin, "alice@example.com", "s3cret")).toBe("filled");
    expect(value("#user")).toBe("alice@example.com");
    expect(value("#pass")).toBe("s3cret");
    expect(value("#search")).toBe("");
  });

  it("refuses when the page is on another origin", () => {
    page(`<input id="pass" type="password">`);
    expect(fillCredentials("https://evil.example", "a", "b")).toBe("origin-mismatch");
    expect(value("#pass")).toBe("");
  });

  it("skips hidden decoy fields", () => {
    page(`<form>
      <input id="decoy" type="password" data-hidden>
      <input id="user" type="text" autocomplete="username">
      <input id="pass" type="password">
    </form>`);
    fillCredentials(origin, "bob", "pw");
    expect(value("#decoy")).toBe("");
    expect(value("#pass")).toBe("pw");
    expect(value("#user")).toBe("bob");
  });

  it("prefers the username field in the password's form", () => {
    page(`<input id="newsletter" type="email">
      <form><input id="user" type="text"><input id="pass" type="password"></form>`);
    fillCredentials(origin, "carol", "pw");
    expect(value("#user")).toBe("carol");
    expect(value("#newsletter")).toBe("");
  });

  it("fills only the username on a username-first step", () => {
    page(`<form><input id="user" type="email" autocomplete="username"></form>`);
    expect(fillCredentials(origin, "dave", "pw")).toBe("filled");
    expect(value("#user")).toBe("dave");
  });

  it("without the password, fills a username-only step", () => {
    page(`<form><input id="user" type="email" autocomplete="username"></form>`);
    expect(fillCredentials(origin, "dave", null)).toBe("filled");
    expect(value("#user")).toBe("dave");
  });

  it("without the password, leaves a form with a password field untouched", () => {
    page(`<form><input id="user" autocomplete="username"><input id="pass" type="password"></form>`);
    expect(fillCredentials(origin, "dave", null)).toBe("needs-password");
    expect(value("#user")).toBe("");
    expect(value("#pass")).toBe("");
  });

  it("does not put a username into a one-time-code field", () => {
    page(`<form><input id="otp" type="text" autocomplete="one-time-code"></form>`);
    expect(fillCredentials(origin, "erin", "pw")).toBe("no-fields");
    expect(value("#otp")).toBe("");
  });

  it("fires input events so frameworks see the change", () => {
    page(`<form><input id="pass" type="password"></form>`);
    const seen: string[] = [];
    document.querySelector("#pass")?.addEventListener("input", (e) => seen.push((e.target as HTMLInputElement).value));
    fillCredentials(origin, "", "pw");
    expect(seen).toEqual(["pw"]);
  });

  it("fills around the field the menu was opened on", () => {
    page(`<form id="a"><input id="user-a" type="email"><input id="pass-a" type="password"></form>
      <form id="b"><input id="user-b" type="email"><input id="pass-b" type="password"></form>`);
    const anchor = document.querySelector("#user-b") as HTMLInputElement;
    expect(fillCredentials(origin, "frank", "pw", anchor)).toBe("filled");
    expect(value("#user-b")).toBe("frank");
    expect(value("#pass-b")).toBe("pw");
    expect(value("#user-a")).toBe("");
    expect(value("#pass-a")).toBe("");
  });
});

describe("fillNewPassword", () => {
  const input = (selector: string) => document.querySelector(selector) as HTMLInputElement;

  it("fills the password and its confirmation", () => {
    page(`<form><input id="email" type="email"><input id="p1" type="password"><input id="p2" type="password"></form>
          <form><input id="other" type="password" autocomplete="new-password"></form>`);
    expect(fillNewPassword(origin, "abc-DEF-123", input("#p1"))).toBe("filled");
    expect(value("#p1")).toBe("abc-DEF-123");
    expect(value("#p2")).toBe("abc-DEF-123");
    expect(value("#email")).toBe("");
    expect(value("#other")).toBe("");
  });

  it("reads the limits of every field it fills, opened on the confirmation too", () => {
    page(`<form><input id="email" type="email">
            <input id="p1" type="password" autocomplete="new-password" maxlength="8" passwordrules="required: digit">
            <input id="p2" type="password" autocomplete="new-password" minlength="6"></form>
          <form><input id="other" type="password" autocomplete="new-password" maxlength="4"></form>`);
    const rules = { minLength: 6, maxLength: 8, passwordRules: ["required: digit"] };
    expect(newPasswordRules(input("#p2"))).toEqual(rules);
    expect(newPasswordRules(input("#p1"))).toEqual(rules);
  });

  it("keeps every field's passwordrules, whichever field the menu is on", () => {
    page(`<form><input id="p1" type="password" passwordrules="maxlength: 8">
            <input id="p2" type="password" passwordrules="required: digit"></form>`);
    const rules = { passwordRules: ["maxlength: 8", "required: digit"] };
    expect(newPasswordRules(input("#p2"))).toEqual(rules);
    expect(newPasswordRules(input("#p1"))).toEqual(rules);
    // the same rules on both: once
    page(`<form><input id="p1" type="password" passwordrules="maxlength: 8">
            <input id="p2" type="password" passwordrules=" maxlength: 8"></form>`);
    expect(newPasswordRules(input("#p2"))).toEqual({ passwordRules: ["maxlength: 8"] });
    page(`<form><input id="p1" type="password"></form>`);
    expect(newPasswordRules(input("#p1"))).toEqual({});
  });

  it("never touches the current password on a change-password form", () => {
    page(
      `<form><input id="old" type="password"><input id="new" type="password"><input id="again" type="password"></form>`,
    );
    expect(fillNewPassword(origin, "x", input("#again"))).toBe("filled");
    expect(value("#old")).toBe("");
    expect(value("#new")).toBe("x");
    expect(value("#again")).toBe("x");
  });

  it("refuses another origin and login password fields", () => {
    page(`<form><input id="p" type="password" autocomplete="new-password"></form>`);
    expect(fillNewPassword("https://elsewhere.example", "x", input("#p"))).toBe("origin-mismatch");
    page(`<form><input id="p" type="password" autocomplete="current-password"></form>`);
    expect(fillNewPassword(origin, "x", input("#p"))).toBe("no-fields");
    expect(value("#p")).toBe("");
  });

  it("skips hidden confirmation fields", () => {
    page(`<form><input id="p1" type="password" autocomplete="new-password">
          <input id="trap" type="password" autocomplete="new-password" data-hidden></form>`);
    fillNewPassword(origin, "x", input("#p1"));
    expect(value("#trap")).toBe("");
  });
});

describe("fillEmail", () => {
  const input = (selector: string) => document.querySelector(selector) as HTMLInputElement;

  it("refuses another origin, and fields the user can't see or edit", () => {
    page(`<input id="email" type="email"><input id="hidden" type="email" data-hidden>
          <input id="readonly" type="email" readonly>`);
    expect(fillEmail("https://elsewhere.example", "jane@example.com", input("#email"))).toBe("origin-mismatch");
    expect(fillEmail(origin, "jane@example.com", input("#hidden"))).toBe("no-fields");
    expect(fillEmail(origin, "jane@example.com", input("#readonly"))).toBe("no-fields");
    const detached = input("#email");
    detached.remove();
    expect(fillEmail(origin, "jane@example.com", detached)).toBe("no-fields");
    expect([detached, input("#hidden"), input("#readonly")].map((el) => el.value)).toEqual(["", "", ""]);
  });
});

describe("asksForUsername", () => {
  it("is true for a sign-up with an email field, even an empty one", () => {
    page(`<form><input id="email" type="email"><input id="new" type="password" autocomplete="new-password"></form>`);
    expect(asksForUsername(document.querySelector("#new") as HTMLInputElement)).toBe(true);
  });

  it("is false for a password reset, which asks for new passwords only", () => {
    page(
      `<form><input id="new" type="password" autocomplete="new-password"><input type="password" autocomplete="new-password"></form>`,
    );
    expect(asksForUsername(document.querySelector("#new") as HTMLInputElement)).toBe(false);
  });

  it("ignores a hidden username field", () => {
    page(`<form><input type="email" data-hidden><input id="new" type="password" autocomplete="new-password"></form>`);
    expect(asksForUsername(document.querySelector("#new") as HTMLInputElement)).toBe(false);
  });
});

describe("usernameNear", () => {
  it("prefers the username, then the email, of the same form", () => {
    page(`<form><input name="first" value="Jane"><input type="email" value="jane@example.com">
          <input id="p" type="password"></form><form><input autocomplete="username" value="elsewhere"></form>`);
    expect(usernameNear(document.querySelector("#p") as HTMLInputElement)).toBe("jane@example.com");
    page(`<form><input type="email" value="jane@example.com"><input autocomplete="username" value="jane">
          <input id="p" type="password"></form>`);
    expect(usernameNear(document.querySelector("#p") as HTMLInputElement)).toBe("jane");
  });

  it("is empty when nothing is typed yet", () => {
    page(`<form><input type="email"><input id="p" type="password"></form>`);
    expect(usernameNear(document.querySelector("#p") as HTMLInputElement)).toBe("");
  });
});

describe("fillOneTimeCode", () => {
  it("fills a code field, keeping focus there for Enter", () => {
    page(`<form><input id="code" autocomplete="one-time-code"><button>Verify</button></form>`);
    const field = document.querySelector("#code") as HTMLInputElement;
    const submitted = vi.fn((e: Event) => e.preventDefault());
    field.form?.addEventListener("submit", submitted);
    expect(fillOneTimeCode(origin, "123456", field)).toBe("filled");
    expect(field.value).toBe("123456");
    expect(document.activeElement).toBe(field);
    expect(submitted).not.toHaveBeenCalled();
  });

  it("spreads a code over one box per digit, in order", () => {
    const boxes = Array.from({ length: 6 }, (_, i) => `<input id="b${i}" maxlength="1" inputmode="numeric">`).join("");
    page(`<form><div>${boxes}</div></form>`);
    const typed: string[] = [];
    document.addEventListener("keydown", (e) => typed.push(`${(e.target as HTMLElement).id}:${e.key}`));
    expect(fillOneTimeCode(origin, "908172", document.querySelector("#b3") as HTMLInputElement)).toBe("filled");
    expect([0, 1, 2, 3, 4, 5].map((i) => value(`#b${i}`)).join("")).toBe("908172");
    expect(typed).toEqual(["b0:9", "b1:0", "b2:8", "b3:1", "b4:7", "b5:2"]);
    expect(document.activeElement?.id).toBe("b5");
  });

  it("types the code when the page undoes a set value", () => {
    page(`<form><input id="code" autocomplete="one-time-code"></form>`);
    const field = document.querySelector("#code") as HTMLInputElement;
    // a controlled input: it only accepts what arrives through typed input events
    let state = "";
    field.addEventListener("input", (e) => {
      const data = (e as InputEvent).data;
      state = data ? state + data : state;
      field.value = state;
    });
    expect(fillOneTimeCode(origin, "424242", field)).toBe("filled");
    expect(field.value).toBe("424242");
  });

  it("respects a page that blocks keys it doesn't want", () => {
    page(`<form><input id="code" autocomplete="one-time-code"></form>`);
    const field = document.querySelector("#code") as HTMLInputElement;
    field.addEventListener("input", () => {
      field.value = field.value.replace(/\D/g, "");
    });
    expect(fillOneTimeCode(origin, "12ab34", field)).toBe("filled");
    expect(field.value).toBe("1234");
  });

  it("refuses another origin, a field that isn't for codes, or one that's gone", () => {
    page(`<form><input id="code" autocomplete="one-time-code"><input id="name" name="name"></form>`);
    const code = document.querySelector("#code") as HTMLInputElement;
    expect(fillOneTimeCode("https://evil.example", "123456", code)).toBe("origin-mismatch");
    expect(fillOneTimeCode(origin, "123456", document.querySelector("#name") as HTMLInputElement)).toBe("no-fields");
    code.remove();
    expect(fillOneTimeCode(origin, "123456", code)).toBe("no-fields");
  });

  it("never puts a code into a hidden decoy", () => {
    page(`<form><input id="code" autocomplete="one-time-code" data-hidden></form>`);
    expect(fillOneTimeCode(origin, "123456", document.querySelector("#code") as HTMLInputElement)).toBe("no-fields");
  });
});
