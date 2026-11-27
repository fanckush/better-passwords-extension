import "./style.css";
import { type SaveCardAnswer, type SaveCardDetails, send } from "@/src/messages.ts";
import { applySystemAccent } from "@/src/ui/accent.ts";
import { h } from "@/src/ui/h.ts";
import { CHECK, icon, KEY } from "@/src/ui/icons.ts";

// The card asking whether to save a login, shown in the page's top right corner (see SaveCardHost)
// for password managers that don't ask themselves. It's an extension page in a closed frame: the
// page can't read it or click it for the user (only trusted clicks count).

applySystemAccent();

const params = new URLSearchParams(window.location.hash.slice(1));
const scheme = params.get("scheme");
if (scheme === "light" || scheme === "dark") document.documentElement.dataset.scheme = scheme;
const nonce = params.get("nonce") ?? "";
const card = document.getElementById("card") as HTMLElement;

function reportSize() {
  const root = getComputedStyle(document.documentElement);
  const height = card.offsetHeight + Number.parseFloat(root.borderTopWidth) + Number.parseFloat(root.borderBottomWidth);
  void send({ type: "save-card-resize", nonce, height: Math.ceil(height) }).catch(() => {});
}

function render(...children: (Node | null)[]) {
  card.replaceChildren(...children.filter((c): c is Node => c !== null));
  reportSize();
}

function head(svg: string, title: string, detail: string) {
  return h(
    "div",
    { class: "head" },
    icon(svg),
    h("div", {}, h("div", { class: "title", textContent: title }), h("div", { class: "detail", textContent: detail })),
  );
}

async function answer(choice: SaveCardAnswer, details: SaveCardDetails, buttons: HTMLButtonElement[]) {
  for (const button of buttons) button.disabled = true;
  try {
    const { saved } = await send({ type: "save-card-answer", nonce, answer: choice });
    if (saved) render(head(CHECK, details.update ? "Password updated" : "Saved", `In ${details.account}`));
  } catch (e) {
    show(details, e instanceof Error ? e.message : String(e));
  }
}

function show(details: SaveCardDetails, error?: string) {
  const who = details.username || "No username";
  const title = details.update ? `Update Password in ${details.account}?` : `Save Login to ${details.account}?`;
  const save = h("button", { class: "primary", textContent: details.update ? "Update" : "Save" });
  const notNow = h("button", { class: "secondary", textContent: "Not Now" });
  const never = h("button", { class: "link never", textContent: "Never for This Site" });
  const buttons = [save, notNow, never];
  const on = (button: HTMLButtonElement, choice: SaveCardAnswer) =>
    button.addEventListener("click", (event) => {
      if (event.isTrusted) void answer(choice, details, buttons);
    });
  on(save, "save");
  on(notNow, "not-now");
  on(never, "never");
  render(
    head(KEY, title, `${who} · ${details.hostname}`),
    error ? h("div", { class: "error", textContent: error }) : null,
    h("div", { class: "actions" }, details.update ? h("span", { class: "never" }) : never, notNow, save),
  );
}

void send({ type: "save-card", nonce })
  .then((details) => show(details))
  .catch(() => void send({ type: "save-card-answer", nonce, answer: "not-now" }).catch(() => {}));
