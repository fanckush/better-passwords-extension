import "./style.css";
import { send } from "@/src/messages.ts";
import { toolbarAction } from "@/src/toolbar.ts";
import { applySystemAccent } from "@/src/ui/accent.ts";
import { h } from "@/src/ui/h.ts";
import { setupFlow } from "@/src/ui/setup.ts";

// The setup flow in a tab of its own: opened on install when this browser can't reach Apple's
// helper yet, and from the inline menu's "Set Up Better Passwords".

applySystemAccent();

const page = document.getElementById("page") as HTMLElement;

/** Unlocking happens in the popup; open it where the browser allows, or say where it is. */
async function openPopup(button: HTMLButtonElement) {
  const action = toolbarAction() as { openPopup?: () => Promise<void> } | undefined;
  try {
    if (!action?.openPopup) throw new Error("no openPopup");
    await action.openPopup();
  } catch {
    button.replaceWith(
      h("p", { class: "note", textContent: "Click the Better Passwords button in your browser's toolbar to unlock." }),
    );
  }
}

async function closeTab() {
  const tab = await browser.tabs.getCurrent();
  if (tab?.id !== undefined) await browser.tabs.remove(tab.id);
  else window.close();
}

async function render() {
  const status = await send({ type: "get-status" }).catch(() => ({ state: "no-helper" as const }));
  page.replaceChildren(
    await setupFlow(status, {
      next: { label: "Unlock Now", run: (button) => void openPopup(button) },
      finish: { label: "Close Tab", run: () => void closeTab() },
    }),
  );
}

void render();
