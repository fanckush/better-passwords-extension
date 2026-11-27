import "./style.css";
import { COMPANION_DOWNLOAD_URL, REPO_URL } from "@/src/config.ts";
import { send } from "@/src/messages.ts";
import { applySystemAccent } from "@/src/ui/accent.ts";
import { h } from "@/src/ui/h.ts";
import { icon, LOCK, PERSON } from "@/src/ui/icons.ts";

// What the optional Mac app adds, in plain words, with what it asks for and one way to get it.
// Every "Get Companion App" in the extension opens this page.

applySystemAccent();

const page = document.getElementById("page") as HTMLElement;

function feature(path: string, title: string, detail: string) {
  return h("li", {}, icon(path), h("div", {}, h("strong", { textContent: title }), h("p", { textContent: detail })));
}

async function render() {
  const status = await send({ type: "get-status" }).catch(() => undefined);
  const installed = status?.companion === "ready" || status?.companion === "needs-setup";
  const update = installed ? status?.companionUpdate : undefined;
  // an app from before updates were built in is replaced by downloading the new one
  const download = !installed || update?.how === "download";
  let label = installed ? "Open Companion App" : "Download for Mac";
  if (update) label = update.how === "download" ? "Download the Update" : `Update to ${update.version}`;

  const primary = h("a", {
    class: "button primary",
    href: download ? COMPANION_DOWNLOAD_URL : "#",
    textContent: label,
  });
  if (!download) {
    primary.addEventListener("click", async (event) => {
      event.preventDefault();
      await send({ type: "open-companion-app" }).catch(() => {});
    });
  }

  page.replaceChildren(
    h("img", { class: "app-icon", src: "/icon/128.png", alt: "" }),
    h("h1", { textContent: "Companion App for Mac" }),
    h("p", { class: "lead", textContent: "Optional and free. It makes Better Passwords a little smoother." }),
    h(
      "ul",
      { class: "features" },
      feature(LOCK, "Skip the 6-digit code", "Confirm with Touch ID, and the code your Mac shows is entered for you."),
      feature(PERSON, "Suggest my emails", "Email fields offer the email addresses on your contact card, like Safari."),
    ),
    h(
      "section",
      { class: "asks" },
      h("h2", { textContent: "What it asks for" }),
      h(
        "ul",
        {},
        h("li", { textContent: "Touch ID, every time it enters a code for you." }),
        h("li", {
          textContent: "Accessibility, only to read the code in Apple's own code window. Your browser never gets it.",
        }),
        h("li", { textContent: "Contacts (optional), only your own card." }),
      ),
    ),
    h(
      "div",
      { class: "actions" },
      primary,
      h("a", { class: "button", href: `${REPO_URL}/blob/main/docs/companion.md`, textContent: "How It Works" }),
    ),
    h("p", {
      class: "fine",
      textContent: "Free and open source. It runs in the background only when the extension needs it.",
    }),
  );
}

void render();
