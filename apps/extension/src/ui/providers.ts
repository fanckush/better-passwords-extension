// The password managers a user can add, as the setup page and the popup show them: a tile (an
// original glyph, not the provider's logo) and a name, in one list to pick from.

import "./tiles.css";
import { OTHER_PROVIDER_ISSUE_URL } from "../config.ts";
import { h } from "./h.ts";
import { CHEVRON_FORWARD, icon, KEY, MORE, OPEN, PROVIDER_GLYPHS } from "./icons.ts";

export type ProviderId = "apple" | "bitwarden";

const PROVIDERS: { id: ProviderId; name: string }[] = [
  { id: "apple", name: "Apple Passwords" },
  { id: "bitwarden", name: "Bitwarden" },
];

/** The provider's tile, as on the picker and at the top of its setup. */
export function providerTile(id: string, size: "small" | "large" = "small"): HTMLElement {
  const glyph = PROVIDER_GLYPHS[id] ?? KEY;
  return h("span", { class: `tile tile-${id} ${size}`, attrs: { "aria-hidden": "true" } }, icon(glyph));
}

/** A login's source, as a small tile on its icon: named for screen readers and on hover. */
export function providerBadge(id: string, label: string): HTMLElement {
  const glyph = PROVIDER_GLYPHS[id] ?? KEY;
  return h(
    "span",
    { class: `tile tile-${id} source`, title: `From ${label}`, attrs: { role: "img", "aria-label": label } },
    icon(glyph),
  );
}

/**
 * One grouped list, a row per password manager that can be added (`hidden`: one that can't be
 * added twice and is already), then "Other", which asks for one on GitHub.
 */
export function providerPicker(options: { hidden?: (id: ProviderId) => boolean; choose: (id: ProviderId) => void }) {
  const rows = PROVIDERS.filter(({ id }) => !options.hidden?.(id)).map(({ id, name }) => {
    const row = h(
      "button",
      { class: "provider", type: "button" },
      providerTile(id),
      h("span", { class: "provider-text" }, h("span", { class: "name", textContent: name })),
      icon(CHEVRON_FORWARD),
    );
    row.addEventListener("click", () => options.choose(id));
    return row;
  });
  const other = h(
    "a",
    { class: "provider", href: OTHER_PROVIDER_ISSUE_URL, target: "_blank", rel: "noopener" },
    h("span", { class: "tile tile-other small", attrs: { "aria-hidden": "true" } }, icon(MORE)),
    h(
      "span",
      { class: "provider-text" },
      h("span", { class: "name", textContent: "Other" }),
      h("span", { class: "provider-detail", textContent: "Ask for it on GitHub" }),
    ),
    icon(OPEN),
  );
  return h("div", { class: "providers" }, ...rows, other);
}
