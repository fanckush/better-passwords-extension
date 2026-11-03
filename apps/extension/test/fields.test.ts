import { describe, expect, it } from "vitest";
import { fieldKind, isLoginField, oneTimeCodeGroup } from "../src/autofill/fields.ts";

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

describe("verification code fields", () => {
  it.each([
    // GitHub's, as of 2026
    [
      "GitHub's marked field",
      `<form><input id="f" name="app_otp" autocomplete="one-time-code" inputmode="numeric" maxlength="6" placeholder="XXXXXX"></form>`,
    ],
    ["field named otp", `<form><input id="f" name="otp"></form>`],
    ["field named app_otp", `<form><input id="f" name="app_otp"></form>`],
    ["field labelled for an authenticator", `<form><label for="f">Authentication code</label><input id="f"></form>`],
    ["two-factor field", `<form><input id="f" name="two_factor_token" type="tel"></form>`],
    ["number-typed code", `<form><input id="f" type="number" name="totp"></form>`],
    ["short numeric field named code", `<form><input id="f" name="code" inputmode="numeric"></form>`],
    ["6-digit field by its pattern", `<form><input id="f" name="pin_code" pattern="\\d{6}"></form>`],
    [
      "unnamed short field on a two-factor page",
      `<h1>Two-factor authentication</h1><form><input id="f" maxlength="6"></form>`,
    ],
  ])("recognises a %s", (_, html) => {
    expect(fieldKind(field(html))).toBe("one-time-code");
  });

  it.each([
    ["card security code", `<form><input id="f" name="security_code" autocomplete="cc-csc"></form>`],
    [
      "CVC beside a card number",
      `<form><input autocomplete="cc-number"><input id="f" name="code" maxlength="4" inputmode="numeric"></form>`,
    ],
    ["zip code", `<form><input id="f" name="zip_code" inputmode="numeric" maxlength="5"></form>`],
    ["postal code", `<form><input id="f" name="code" autocomplete="postal-code" maxlength="5"></form>`],
    ["promo code", `<form><input id="f" name="promo_code"></form>`],
    ["phone number", `<form><input id="f" type="tel" name="phone"></form>`],
    ["recovery code", `<form><input id="f" name="recovery_code"></form>`],
    ["plain text field named code", `<form><input id="f" name="code"></form>`],
    ["field whose name only contains otp", `<form><input id="f" name="footprint" maxlength="6"></form>`],
    ["short numeric field elsewhere", `<form><input id="f" name="quantity" inputmode="numeric" maxlength="4"></form>`],
    ["email verification address", `<form><input id="f" type="email" name="verification_email"></form>`],
    ["search box for codes", `<form role="search"><input id="f" name="code" maxlength="6"></form>`],
  ])("leaves a %s alone", (_, html) => {
    expect(fieldKind(field(html))).not.toBe("one-time-code");
  });

  it("treats one box per digit as a single code field", () => {
    const boxes = Array.from({ length: 6 }, (_, i) => `<input id="b${i}" maxlength="1" inputmode="numeric">`).join("");
    document.body.innerHTML = `<form><div class="digits">${boxes}</div></form>`;
    const third = document.querySelector<HTMLInputElement>("#b2");
    expect(fieldKind(third)).toBe("one-time-code");
    expect(oneTimeCodeGroup(third as HTMLInputElement).map((b) => b.id)).toEqual(["b0", "b1", "b2", "b3", "b4", "b5"]);
  });

  it("finds boxes wrapped one per element", () => {
    const boxes = Array.from({ length: 4 }, (_, i) => `<span><input id="b${i}" maxlength="1"></span>`).join("");
    document.body.innerHTML = `<form><div>${boxes}</div></form>`;
    expect(oneTimeCodeGroup(document.querySelector("#b3") as HTMLInputElement)).toHaveLength(4);
  });

  it("doesn't take a lone one-character field for a split code", () => {
    const el = field(`<form><input id="f" name="initial" maxlength="1"></form>`);
    expect(oneTimeCodeGroup(el)).toEqual([el]);
    expect(fieldKind(el)).toBeUndefined();
  });

  it("never offers logins in a code field", () => {
    expect(isLoginField(field(`<form><input id="f" autocomplete="one-time-code"><input type="password"></form>`))).toBe(
      false,
    );
  });
});
