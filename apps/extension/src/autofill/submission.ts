// When a sign-up or sign-in has moved on, so Apple Passwords is asked to save a generated password
// then, as is any other password a sign-in sends.
//
// Like Safari, the cue is the page moving on with the password: its field goes away (a dialog
// closes, a multi-step form moves on; watchUntilGone) or the tab navigates (watched by the
// background). An invalid or rejected form keeps the field, so nothing is asked.

import { usernameNear } from "../fill.ts";
import { isNewPasswordField } from "./fields.ts";

/** Whether the field is gone from the page or no longer shown. */
export function isGone(field: HTMLInputElement): boolean {
  if (!field.isConnected) return true;
  const rect = field.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return true;
  return getComputedStyle(field).visibility === "hidden";
}

/** Calls `onGone` once when the field goes away. Returns a function that stops watching. */
export function watchUntilGone(field: HTMLInputElement, onGone: () => void, intervalMs = 300): () => void {
  const timer = setInterval(() => {
    if (!isGone(field)) return;
    clearInterval(timer);
    onGone();
  }, intervalMs);
  return () => clearInterval(timer);
}

/** Inputs whose value is a username or email, remembered for multi-step sign-ups. */
export function isUsernameInput(el: EventTarget | null): el is HTMLInputElement {
  if (!(el instanceof HTMLInputElement) || !["text", "email", "tel", ""].includes(el.type)) return false;
  const autocomplete = el.autocomplete.toLowerCase();
  if (/one-time-code|cc-|address|search/.test(autocomplete)) return false;
  return (
    el.type === "email" ||
    /\b(username|email)\b/.test(autocomplete) ||
    /user|login|e-?mail|account|identifier/i.test(`${el.name} ${el.id}`)
  );
}

// Other logins are saved the same way: captured as the form is sent (a submit, Enter in a field,
// a click on a button), saved once the page has moved on.

/** The password a form was sent with, and the username next to it. */
export interface SentLogin {
  field: HTMLInputElement;
  username: string;
  password: string;
}

/**
 * The login filled into `scope` (a form, or the part of a page around formless fields): the new
 * password on a sign-up or a change of password, else the password. `fallbackUsername` is the one
 * typed on an earlier step (multi-step sign-ins).
 */
export function sentLogin(scope: ParentNode, fallbackUsername = ""): SentLogin | undefined {
  const filled = Array.from(scope.querySelectorAll("input")).filter(
    (el) => el.type === "password" && el.value !== "" && !isGone(el),
  );
  const field = filled.find(isNewPasswordField) ?? filled[0];
  if (!field) return undefined;
  return { field, username: usernameNear(field) || fallbackUsername, password: field.value };
}

/**
 * What a click on `target`, or Enter in it, would send: its form, or for fields outside any form
 * the nearest element around it that has a password field (not the whole page: a cookie banner's
 * button is no sign-in). Undefined when the click isn't on a button.
 */
export function submittedScope(target: EventTarget | null, key?: string): ParentNode | undefined {
  if (!(target instanceof Element)) return undefined;
  const sender =
    key === "Enter"
      ? target instanceof HTMLInputElement
        ? target
        : undefined
      : target.closest("button, input[type=submit], input[type=image], [role=button]");
  if (!sender) return undefined;
  const form = (sender as HTMLButtonElement | HTMLInputElement).form ?? sender.closest("form");
  if (form) return form;
  for (let el = sender.parentElement; el && el !== el.ownerDocument.body; el = el.parentElement) {
    if (el.querySelector("input[type=password]")) return el;
  }
  return undefined;
}

/**
 * Whether a submit event comes from the user, so a sign-in it sends may be offered for saving. A
 * page's own script can send a form at any time; without this, it could make Apple Passwords offer
 * to save or update a password of its choosing. A script that sends the form in answer to the
 * user (a click or Enter handled in script, then requestSubmit) still counts: the page has
 * transient user activation then. Without the userActivation API, nothing changes.
 */
export function isUserSubmit(
  event: Pick<Event, "isTrusted">,
  activation: { isActive: boolean } | undefined = (navigator as { userActivation?: { isActive: boolean } })
    .userActivation,
): boolean {
  return event.isTrusted || (activation?.isActive ?? true);
}
