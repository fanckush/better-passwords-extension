// Keeps the browser's own passkey list out of login fields while "Hide browser passkey list" is on
// (issue #29), so it doesn't cover the inline menu.
//
// Chromium lists passkeys (and "Use a passkey from another device") only on a field whose
// autocomplete attribute has the "webauthn" token. It reads that attribute from the page each time
// the user clicks the field (TriggeringField::show_webauthn_credentials). The passkeys themselves
// come from the site's own conditional request, which the browser keeps pending from page load.
// So we take only the token out, and keep the page's value to put it back: the site's request is
// untouched, and the browser's full list shows again as soon as the token is back.
//
// Both content scripts read the same state from the page's DOM: the page's value is kept in
// ATTRIBUTE_ORIGINAL on each field we changed.

export const ATTRIBUTE_ORIGINAL = "data-better-passwords-autocomplete";
/** On a field that shows the browser's list right now: it keeps its token until the user leaves it. */
const ATTRIBUTE_SHOWING = "data-better-passwords-passkeys-shown";
const TAGGED = 'input[autocomplete~="webauthn" i], textarea[autocomplete~="webauthn" i]';

const isToken = (token: string) => token.toLowerCase() === "webauthn";
const hasToken = (value: string) => value.split(/\s+/).some(isToken);
const withoutToken = (value: string) =>
  value
    .split(/\s+/)
    .filter((token) => token !== "" && !isToken(token))
    .join(" ");

function setAutocomplete(field: Element, value: string) {
  if (value === "") field.removeAttribute("autocomplete");
  else field.setAttribute("autocomplete", value);
}

/** Takes the "webauthn" token out of `field`'s autocomplete, keeping the page's value. */
export function hidePasskeyList(field: Element): void {
  if (!field.matches("input, textarea") || field.hasAttribute(ATTRIBUTE_SHOWING)) return;
  const value = field.getAttribute("autocomplete") ?? "";
  if (hasToken(value)) {
    field.setAttribute(ATTRIBUTE_ORIGINAL, value);
    setAutocomplete(field, withoutToken(value));
    return;
  }
  // the page set a value of its own since (without the token): ours is out of date
  const original = field.getAttribute(ATTRIBUTE_ORIGINAL);
  if (original !== null && value !== withoutToken(original)) field.removeAttribute(ATTRIBUTE_ORIGINAL);
}

/** Whether the browser's passkey list was hidden on `field`, so the menu can offer to show it. */
export function hasHiddenPasskeyList(field: Element): boolean {
  return field.hasAttribute(ATTRIBUTE_ORIGINAL);
}

/** Gives `field` its page's value back for good. */
export function restorePasskeyList(field: Element): void {
  const original = field.getAttribute(ATTRIBUTE_ORIGINAL);
  if (original === null) return;
  field.removeAttribute(ATTRIBUTE_ORIGINAL);
  field.removeAttribute(ATTRIBUTE_SHOWING);
  setAutocomplete(field, original);
}

/**
 * Puts the token back on `field` until the user has been in it once: the browser shows its list on
 * their next click there. When they leave the field, the token comes out again and `done` runs.
 * Returns false if the list wasn't hidden on `field`.
 */
export function showPasskeyListOnce(field: HTMLElement, done?: () => void): boolean {
  const original = field.getAttribute(ATTRIBUTE_ORIGINAL);
  if (original === null) return false;
  field.setAttribute(ATTRIBUTE_SHOWING, "");
  setAutocomplete(field, original);
  // the field may still have the focus (keyboard), or get it with the user's next click
  const arm = () => {
    field.addEventListener(
      "focusout",
      () => {
        field.removeAttribute(ATTRIBUTE_SHOWING);
        hidePasskeyList(field);
        done?.();
      },
      { once: true },
    );
  };
  if (field.ownerDocument.activeElement === field) arm();
  else field.addEventListener("focusin", arm, { once: true });
  return true;
}

/**
 * Hides the browser's passkey list on every tagged field, now and as the page adds or tags more
 * (sites like GitHub add the token from a script). Returns a function that stops and restores them.
 */
export function watchPasskeyLists(doc: Document = document): () => void {
  const hideIn = (node: Node) => {
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const element = node as Element;
    if (element.matches(TAGGED)) hidePasskeyList(element);
    for (const field of element.querySelectorAll(TAGGED)) hidePasskeyList(field);
  };
  // ponytail: watches the whole page for its lifetime; scope it to forms if this shows up in profiles
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "attributes") hidePasskeyList(record.target as Element);
      else record.addedNodes.forEach(hideIn);
    }
  });
  observer.observe(doc, { subtree: true, childList: true, attributes: true, attributeFilter: ["autocomplete"] });
  if (doc.documentElement) hideIn(doc.documentElement);
  return () => {
    observer.disconnect();
    for (const field of doc.querySelectorAll(`[${ATTRIBUTE_ORIGINAL}]`)) restorePasskeyList(field);
  };
}
