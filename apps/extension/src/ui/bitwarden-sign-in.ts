// Signing in to Bitwarden, on the setup page: server, email and master password, then the code
// Bitwarden asks for, if any (two-step login, or a new device). The master password stays in this
// page between steps, and is sent only to the background, which signs in.

import "./setup.css";
import { SELF_HOSTED_ISSUE_URL } from "../config.ts";
import type { BitwardenRegion, BitwardenSignIn, BitwardenSignInStep } from "../messages.ts";
import { send } from "../messages.ts";
import { bindCodeInput } from "./code-input.ts";
import { h } from "./h.ts";
import { providerTile } from "./providers.ts";

export interface BitwardenSignInOptions {
  /** Signing in again to an account that Bitwarden signed out: its id and email. */
  account?: { id: string; email?: string };
  /** Once signed in, with the account's id: what shows next. */
  done: (account: string) => void;
}

const AUTHENTICATOR = 0;
const EMAIL = 1;

/** The sign-in, and its way back a step: from a code to the form (false: at the first step already). */
export interface SignInFlow {
  element: HTMLElement;
  back(): boolean;
}

/** The request the code step was for, to go back to the form with it filled in. */
const codeSteps = new WeakMap<HTMLElement, BitwardenSignIn>();

export function bitwardenSignIn(options: BitwardenSignInOptions): SignInFlow {
  const root = h("div", { class: "setup sign-in" });
  showForm(root, options);
  return {
    element: root,
    back() {
      const request = codeSteps.get(root);
      if (!request) return false;
      showForm(root, options, undefined, request);
      return true;
    },
  };
}

function field(label: string, input: HTMLInputElement | HTMLSelectElement) {
  return h("label", { class: "field" }, h("span", { textContent: label }), input);
}

function errorLine() {
  return h("p", { class: "error", hidden: true, attrs: { role: "alert" } });
}

function showError(line: HTMLElement, error: unknown) {
  line.textContent = error instanceof Error ? error.message : String(error);
  line.hidden = false;
}

function showForm(root: HTMLElement, options: BitwardenSignInOptions, error?: unknown, filled?: BitwardenSignIn) {
  codeSteps.delete(root);
  const server = h(
    "select",
    { name: "server" },
    h("option", { value: "us", textContent: "bitwarden.com" }),
    h("option", { value: "eu", textContent: "bitwarden.eu" }),
    h("option", { value: "self-hosted", textContent: "Self-hosted" }),
  );
  const email = h("input", {
    type: "email",
    name: "email",
    required: true,
    autocomplete: "username",
    value: filled?.email ?? options.account?.email ?? "",
  });
  const password = h("input", {
    type: "password",
    name: "password",
    required: true,
    autocomplete: "current-password",
    value: filled?.password ?? "",
  });
  if (filled) server.value = filled.region;
  const submit = h("button", { class: "button primary", type: "submit", textContent: "Sign In" });
  const problem = errorLine();
  if (error) showError(problem, error);

  const selfHosted = h(
    "p",
    { class: "note", hidden: true },
    "Self-hosted servers aren't supported yet. ",
    h("a", { href: SELF_HOSTED_ISSUE_URL, target: "_blank", rel: "noopener", textContent: "Ask for them on GitHub" }),
  );
  const fields = [email, password, submit];
  server.addEventListener("change", () => {
    const unsupported = server.value === "self-hosted";
    selfHosted.hidden = !unsupported;
    for (const input of fields) input.disabled = unsupported;
  });

  const form = h(
    "form",
    { class: "form" },
    field("Server", server),
    field("Email", email),
    field("Master password", password),
    problem,
    selfHosted,
    submit,
  );
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    problem.hidden = true;
    for (const input of fields) input.disabled = true;
    submit.textContent = "Signing In…";
    const request: BitwardenSignIn = {
      region: server.value as BitwardenRegion,
      email: email.value.trim(),
      password: password.value,
    };
    try {
      await next(root, options, request, await signIn(options, request));
    } catch (e) {
      showError(problem, e);
      for (const input of fields) input.disabled = false;
      submit.textContent = "Sign In";
      password.select();
    }
  });

  root.replaceChildren(
    providerTile("bitwarden", "large"),
    h("h1", { textContent: options.account ? "Sign In to Bitwarden Again" : "Sign In to Bitwarden" }),
    form,
  );
  (options.account?.email || filled ? password : email).focus();
}

function signIn(options: BitwardenSignInOptions, request: BitwardenSignIn): Promise<BitwardenSignInStep> {
  return send({
    type: "bitwarden-sign-in",
    ...(options.account ? { account: options.account.id } : {}),
    ...request,
  });
}

async function next(
  root: HTMLElement,
  options: BitwardenSignInOptions,
  request: BitwardenSignIn,
  step: BitwardenSignInStep,
): Promise<void> {
  if (step.status === "signed-in") {
    codeSteps.delete(root);
    return options.done(step.account);
  }
  if (step.status === "new-device") {
    return showCode(root, options, request, {
      title: "Check Your Email",
      lead: "Bitwarden emailed you a code to confirm this browser.",
      send: (code) => ({ ...request, newDeviceCode: code }),
    });
  }
  const { providers } = step;
  if (providers.includes(AUTHENTICATOR)) {
    return showCode(root, options, request, {
      title: "Enter Your Verification Code",
      lead: "From your authenticator app.",
      send: (code) => ({ ...request, twoFactor: { provider: AUTHENTICATOR, code } }),
      ...(providers.includes(EMAIL)
        ? { other: { label: "Email Me a Code Instead", run: () => emailCode(step.email) } }
        : {}),
    });
  }
  if (providers.includes(EMAIL)) return emailCode(step.email);
  throw new Error(
    "Better Passwords can't use this account's two-step login yet. Use an authenticator app or email codes in Bitwarden.",
  );

  async function emailCode(address: string | undefined) {
    await send({
      type: "bitwarden-send-email-code",
      region: request.region,
      email: request.email,
      password: request.password,
    });
    return showCode(root, options, request, {
      title: "Check Your Email",
      lead: address ? `Bitwarden emailed a code to ${address}.` : "Bitwarden emailed you a code.",
      send: (code) => ({ ...request, twoFactor: { provider: EMAIL, code } }),
    });
  }
}

interface CodeStep {
  title: string;
  lead: string;
  send: (code: string) => BitwardenSignIn;
  other?: { label: string; run: () => Promise<void> };
}

function showCode(root: HTMLElement, options: BitwardenSignInOptions, request: BitwardenSignIn, step: CodeStep) {
  const input = h("input", {
    class: "code",
    inputMode: "numeric",
    autocomplete: "one-time-code",
    ariaLabel: "Verification code",
  });
  const problem = errorLine();
  const busy = h("p", { class: "waiting", hidden: true }, h("span", { class: "spinner" }), "Signing in…");
  bindCodeInput(input, async (code) => {
    input.disabled = true;
    busy.hidden = false;
    problem.hidden = true;
    try {
      await next(root, options, request, await signIn(options, step.send(code)));
    } catch (e) {
      showError(problem, e);
      busy.hidden = true;
      input.disabled = false;
      input.value = "";
      input.focus();
    }
  });
  const other = step.other ? h("button", { class: "link", type: "button", textContent: step.other.label }) : null;
  other?.addEventListener("click", () => {
    void step.other?.run().catch((e) => showError(problem, e));
  });
  root.replaceChildren(
    providerTile("bitwarden", "large"),
    h("h1", { textContent: step.title }),
    h("p", { class: "lead", textContent: step.lead }),
    input,
    busy,
    problem,
    ...(other ? [h("div", { class: "links" }, other)] : []),
  );
  codeSteps.set(root, request);
  input.focus();
}
