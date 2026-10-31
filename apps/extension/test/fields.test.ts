import { describe, expect, it } from "vitest";
import { fieldKind, isLoginField } from "../src/autofill/fields.ts";

function field(html: string, selector = "#f"): HTMLInputElement {
  document.body.innerHTML = html;
  return document.querySelector(selector) as HTMLInputElement;
}

describe("isLoginField", () => {
  it.each([
    ["password field", `<input id="f" type="password">`],
    ["current-password", `<input id="f" type="password" autocomplete="current-password">`],
    ["explicit username", `<input id="f" autocomplete="username">`],
    ["email next to a password", `<form><input id="f" type="email"><input type="password"></form>`],
    ["login-named text field", `<form><input id="f" name="login"><input type="password"></form>`],
    ["username-first step", `<form><input id="f" type="email" autocomplete="username webauthn"></form>`],
    ["text field with the email keyboard", `<form><input id="f" inputmode="email"><input type="password"></form>`],
    ["field named by its label", `<form><label for="f">Login</label><input id="f"><input type="password"></form>`],
    [
      // XING's: marked as an email, but named for the account
      "forgot-password email named username",
      `<form><label for="f">E-mail</label><input id="f" type="email" name="username" autocomplete="email"><button>Next</button></form>`,
    ],
    ["lone field named identifier", `<form><input id="f" type="email" name="identifier"></form>`],
    ["sign-in's email step", `<form><input id="f" type="email" name="email"><button>Sign in</button></form>`],
  ])("accepts a %s", (_, html) => {
    expect(isLoginField(field(html))).toBe(true);
  });

  it.each([
    ["sign-up password", `<input id="f" type="password" autocomplete="new-password">`],
    ["search box", `<form><input id="f" type="search"><input type="password"></form>`],
    ["newsletter email", `<form><input id="f" type="email"></form>`],
    ["one-time code", `<form><input id="f" autocomplete="one-time-code"><input type="password"></form>`],
    ["unrelated text field", `<form><input id="f" name="city"><input type="password"></form>`],
    ["lone field named for a user's detail", `<form><input id="f" name="user[first_name]"></form>`],
    ["disabled field", `<input id="f" type="password" disabled>`],
    ["checkbox", `<form><input id="f" type="checkbox" name="remember-login"><input type="password"></form>`],
  ])("ignores a %s", (_, html) => {
    expect(isLoginField(field(html))).toBe(false);
  });

  it("ignores things that are not inputs", () => {
    document.body.innerHTML = `<textarea id="t"></textarea>`;
    expect(isLoginField(document.querySelector("#t"))).toBe(false);
    expect(isLoginField(null)).toBe(false);
  });
});

describe("fieldKind", () => {
  it.each([
    ["new-password", `<input id="f" type="password" autocomplete="new-password">`, "new-password"],
    [
      "password with confirmation",
      `<form><input type="email"><input id="f" type="password"><input type="password"></form>`,
      "new-password",
    ],
    [
      "confirmation field",
      `<form><input type="email"><input type="password"><input id="f" type="password"></form>`,
      "new-password",
    ],
    [
      "change password: new",
      `<form><input type="password"><input id="f" type="password"><input type="password"></form>`,
      "new-password",
    ],
    [
      "change password: current",
      `<form><input id="f" type="password"><input type="password"><input type="password"></form>`,
      "login",
    ],
    [
      "sign-up form by its button",
      `<form><input type="email"><input id="f" type="password"><button>Create account</button></form>`,
      "new-password",
    ],
    ["login form", `<form><input type="email"><input id="f" type="password"><button>Sign in</button></form>`, "login"],
    [
      "sign-up email",
      `<form><input id="f" type="email"><input type="password" autocomplete="new-password"></form>`,
      "email",
    ],
    [
      "sign-up email marked as username",
      `<form><input id="f" type="email" autocomplete="username"><input type="password" autocomplete="new-password"></form>`,
      "email",
    ],
    [
      "email on a register form without a password yet",
      `<form id="register"><input id="f" type="email" name="email"><button>Continue</button></form>`,
      "email",
    ],
    ["login email", `<form><input id="f" type="email"><input type="password"><button>Log in</button></form>`, "login"],
    [
      "sign-up email with the email keyboard",
      `<form><input id="f" type="text" inputmode="email"><input type="password" autocomplete="new-password"></form>`,
      "email",
    ],
    [
      // no form, no name, a generated id: only the label says what it is (a Salesforce sign-up)
      "sign-up email named by its label",
      `<div><label for="f">*E-Mail-Adresse (Login)</label><input id="f" type="text"></div>
       <input type="password"><input type="password"><button>REGISTRIEREN</button>`,
      "email",
    ],
    ["newsletter email", `<form><input id="f" type="email"><button>Subscribe</button></form>`, "email"],
    ["lone field with the email keyboard", `<input id="f" type="text" inputmode="email">`, "email"],
    ["lone field named by its label", `<label for="f">E-Mail</label><input id="f" type="text">`, "email"],
    [
      "forgot-password email named username",
      `<form><input id="f" type="email" name="username" autocomplete="email"><button>Next</button></form>`,
      "login",
    ],
    ["sign-in's email step", `<form><input id="f" type="email"><button>Log in</button></form>`, "login"],
  ])("classifies a %s", (_, html, kind) => {
    expect(fieldKind(field(html))).toBe(kind);
  });

  it.each([
    [
      "chosen username on a sign-up form",
      `<form><input id="f" name="username"><input type="password" autocomplete="new-password"></form>`,
    ],
    ["search box", `<input id="f" type="search">`],
    ["search box that takes emails", `<input id="f" type="text" inputmode="email" autocomplete="search">`],
    [
      // Outlook's: a plain text field whose label mentions email
      "search box that mentions email",
      `<input id="f" type="text" role="combobox" aria-label="Search for email, meetings, files and more." placeholder="Search">`,
    ],
    ["field in a search landmark", `<div role="search"><input id="f" type="text" aria-label="Email"></div>`],
    ["unrelated text field", `<form><input id="f" name="city"><button>Subscribe</button></form>`],
  ])("ignores a %s", (_, html) => {
    expect(fieldKind(field(html))).toBeUndefined();
  });
});
