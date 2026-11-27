import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ATTRIBUTE_ORIGINAL,
  hasHiddenPasskeyList,
  hidePasskeyList,
  restorePasskeyList,
  showPasskeyListOnce,
  stopShowingPasskeyList,
  watchPasskeyLists,
} from "../src/autofill/passkey-list.ts";

function field(autocomplete?: string): HTMLInputElement {
  const input = document.createElement("input");
  if (autocomplete !== undefined) input.setAttribute("autocomplete", autocomplete);
  document.body.append(input);
  return input;
}

/** MutationObserver callbacks run as microtasks. */
const observed = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  document.body.replaceChildren();
});

describe("hidePasskeyList", () => {
  it("takes the webauthn token out and keeps the page's value", () => {
    const input = field("username webauthn");
    hidePasskeyList(input);
    expect(input.getAttribute("autocomplete")).toBe("username");
    expect(input.getAttribute(ATTRIBUTE_ORIGINAL)).toBe("username webauthn");
    expect(hasHiddenPasskeyList(input)).toBe(true);
    // again: nothing changes
    hidePasskeyList(input);
    expect(input.getAttribute(ATTRIBUTE_ORIGINAL)).toBe("username webauthn");
  });

  it("matches the token in any case and position", () => {
    const input = field("WebAuthn  username");
    hidePasskeyList(input);
    expect(input.getAttribute("autocomplete")).toBe("username");
  });

  it("leaves fields without the token alone", () => {
    const input = field("username");
    hidePasskeyList(input);
    expect(input.getAttribute("autocomplete")).toBe("username");
    expect(hasHiddenPasskeyList(input)).toBe(false);
  });

  it("removes an attribute that had only the token, and puts it back", () => {
    const input = field("webauthn");
    hidePasskeyList(input);
    expect(input.hasAttribute("autocomplete")).toBe(false);
    restorePasskeyList(input);
    expect(input.getAttribute("autocomplete")).toBe("webauthn");
    expect(hasHiddenPasskeyList(input)).toBe(false);
  });

  it("forgets the page's value once the page sets another one without the token", () => {
    const input = field("username webauthn");
    hidePasskeyList(input);
    input.setAttribute("autocomplete", "email");
    hidePasskeyList(input);
    expect(hasHiddenPasskeyList(input)).toBe(false);
    expect(input.getAttribute("autocomplete")).toBe("email");
  });

  it("only touches inputs and textareas", () => {
    const form = document.createElement("form");
    form.setAttribute("autocomplete", "webauthn");
    hidePasskeyList(form);
    expect(form.getAttribute("autocomplete")).toBe("webauthn");
  });
});

describe("stopShowingPasskeyList", () => {
  it("takes the token out again before the user leaves the field", () => {
    const input = field("username webauthn");
    hidePasskeyList(input);
    showPasskeyListOnce(input);
    expect(input.getAttribute("autocomplete")).toBe("username webauthn");
    stopShowingPasskeyList(input);
    expect(input.getAttribute("autocomplete")).toBe("username");
    expect(hasHiddenPasskeyList(input)).toBe(true);
  });

  it("leaves a field that isn't showing the list alone", () => {
    const input = field("username webauthn");
    stopShowingPasskeyList(input);
    expect(input.getAttribute("autocomplete")).toBe("username webauthn");
  });
});

describe("showPasskeyListOnce", () => {
  it("does nothing where the list wasn't hidden", () => {
    expect(showPasskeyListOnce(field("username"))).toBe(false);
  });

  it("puts the token back until the user has been in the field once", () => {
    const input = field("username webauthn");
    hidePasskeyList(input);
    const done = vi.fn();
    expect(showPasskeyListOnce(input, done)).toBe(true);
    expect(input.getAttribute("autocomplete")).toBe("username webauthn");
    // another strip (a page mutation) while it's shown changes nothing
    hidePasskeyList(input);
    expect(input.getAttribute("autocomplete")).toBe("username webauthn");

    // the user's next click: in the field, the token stays
    input.dispatchEvent(new FocusEvent("focusin"));
    expect(input.getAttribute("autocomplete")).toBe("username webauthn");
    // they leave it: hidden again
    input.dispatchEvent(new FocusEvent("focusout"));
    expect(input.getAttribute("autocomplete")).toBe("username");
    expect(hasHiddenPasskeyList(input)).toBe(true);
    expect(done).toHaveBeenCalledOnce();
  });

  it("hides it again when a field that still has the focus loses it", () => {
    const input = field("username webauthn");
    hidePasskeyList(input);
    input.focus();
    showPasskeyListOnce(input);
    input.dispatchEvent(new FocusEvent("focusout"));
    expect(input.getAttribute("autocomplete")).toBe("username");
  });
});

describe("watchPasskeyLists", () => {
  it("hides fields that are there, added later, or tagged later, and stops cleanly", async () => {
    const early = field("username webauthn");
    const stop = watchPasskeyLists(document);
    expect(early.getAttribute("autocomplete")).toBe("username");

    const added = document.createElement("div");
    added.innerHTML = '<input id="added" autocomplete="email webauthn">';
    document.body.append(added);
    const tagged = field("username");
    tagged.setAttribute("autocomplete", "username webauthn");
    await observed();
    expect(document.getElementById("added")?.getAttribute("autocomplete")).toBe("email");
    expect(tagged.getAttribute("autocomplete")).toBe("username");

    stop();
    expect(early.getAttribute("autocomplete")).toBe("username webauthn");
    expect(tagged.getAttribute("autocomplete")).toBe("username webauthn");
    // stopped: no longer hidden
    const late = field("username webauthn");
    await observed();
    expect(late.getAttribute("autocomplete")).toBe("username webauthn");
  });

  it("leaves a field alone while it shows the browser's list", async () => {
    const input = field("username webauthn");
    const stop = watchPasskeyLists(document);
    showPasskeyListOnce(input);
    await observed();
    expect(input.getAttribute("autocomplete")).toBe("username webauthn");
    stop();
  });
});
