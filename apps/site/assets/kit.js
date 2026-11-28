// Interactive landing-page demo, reveal effects and unlock animations.
globalThis.Kit = (() => {
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const ICON = "icon.svg";
  const clamp = (n) => Math.min(1, Math.max(0, n));
  const randomCode = () => String(Math.floor(Math.random() * 1e6)).padStart(6, "0");
  const spaced = (code) => `${code.slice(0, 3)} ${code.slice(3)}`;

  // .reveal gets .in once it's on screen.
  function reveal() {
    const els = document.querySelectorAll(".reveal");
    if (reduce || !("IntersectionObserver" in window))
      return els.forEach((e) => {
        e.classList.add("in");
      });
    const io = new IntersectionObserver(
      (entries) => {
        // Anything already scrolled past shows at once, so fast scrolls don't leave gaps.
        for (const e of entries)
          if (e.isIntersecting || e.boundingClientRect.top < 0) {
            e.target.classList.add("in");
            io.unobserve(e.target);
          }
      },
      { threshold: 0.1 },
    );
    els.forEach((e) => {
      io.observe(e);
    });
  }

  // Six digits that roll when they change.
  function roller(el, code = randomCode()) {
    el.classList.add("roller");
    el.setAttribute("aria-label", spaced(code));
    el.innerHTML = [...code].map((d, i) => `<span class="d${i === 3 ? " gap" : ""}"><span>${d}</span></span>`).join("");
    const cells = [...el.querySelectorAll(".d > span")];
    return {
      get code() {
        return code;
      },
      set(next = randomCode()) {
        code = next;
        el.setAttribute("aria-label", spaced(code));
        cells.forEach((c, i) => {
          c.textContent = code[i];
          if (!reduce)
            c.animate(
              [
                { transform: "translateY(-70%)", opacity: 0, filter: "blur(4px)" },
                { transform: "none", opacity: 1, filter: "none" },
              ],
              { duration: 520, delay: i * 45, easing: "cubic-bezier(.2,.8,.2,1)", fill: "backwards" },
            );
        });
        return code;
      },
    };
  }

  // A fingerprint: dim ridges plus a lit copy revealed by set(p).
  function print(svg) {
    const NS = "http://www.w3.org/2000/svg";
    svg.setAttribute("viewBox", "0 0 200 200");
    const ring = document.createElementNS(NS, "circle");
    ring.setAttribute("class", "fp-ring");
    Object.entries({ cx: 100, cy: 100, r: 96, pathLength: 1 }).forEach(([k, v]) => {
      ring.setAttribute(k, v);
    });
    svg.append(ring);
    const lit = [];
    // Sized to sit inside the ring (r = 96): the tallest ridge tops out about 20 below the ring.
    const cx = 100,
      cy = 110,
      SQ = 1.24;
    for (let i = 0; i < 8; i++) {
      const r = 7 + i * 8.4;
      const tilt = [0, 18, -14, 26, -22, 10, -30, 6][i];
      const span = [200, 230, 250, 215, 240, 205, 225, 190][i];
      const start = 90 + (360 - span) / 2 + tilt;
      const a0 = (start * Math.PI) / 180,
        a1 = ((start + span) * Math.PI) / 180;
      const d = `M${(cx + r * Math.cos(a0)).toFixed(1)} ${(cy + r * Math.sin(a0) * SQ).toFixed(1)} A${r} ${(r * SQ).toFixed(1)} 0 1 1 ${(cx + r * Math.cos(a1)).toFixed(1)} ${(cy + r * Math.sin(a1) * SQ).toFixed(1)}`;
      for (const on of [false, true]) {
        const p = document.createElementNS(NS, "path");
        p.setAttribute("d", d);
        p.setAttribute("class", on ? "fp-ridge lit" : "fp-ridge");
        svg.append(p);
        if (on) lit.push(p);
      }
    }
    // Each ridge lights from its middle out to both ends, starting at slightly uneven moments,
    // so the print fills in organically rather than sweeping in one direction.
    const lens = lit.map((p) => p.getTotalLength());
    const starts = [0, 0.08, 0.18, 0.05, 0.26, 0.14, 0.32, 0.22];
    const draw = (el, len, f) => {
      const a = len * f;
      el.style.strokeDasharray = `${a} ${len}`;
      el.style.strokeDashoffset = `${-(len - a) / 2}`;
    };
    const api = {
      set(p) {
        svg.style.setProperty("--p", p);
        // The ring grows from the top down both sides (it's rotated to start at the bottom).
        ring.style.strokeDasharray = `${p} 1`;
        ring.style.strokeDashoffset = `${-(1 - p) / 2}`;
        lit.forEach((el, i) => {
          draw(el, lens[i], clamp((p - starts[i]) / 0.62));
        });
      },
    };
    api.set(0);
    return api;
  }

  // Press and hold (pointer, Space or Return) to fill the print; calls done() when full.
  function hold(button, fp, done, { duration = 900 } = {}) {
    let p = 0,
      last = 0,
      holding = false,
      raf = 0;
    const tick = (t) => {
      const dt = last ? t - last : 16;
      last = t;
      p = clamp(p + (holding ? dt / (reduce ? 1 : duration) : -dt / 350));
      fp.set(p);
      if (p >= 1) {
        holding = false;
        button.classList.remove("holding");
        done();
        return;
      }
      if (holding || p > 0) raf = requestAnimationFrame(tick);
      else last = 0;
    };
    const start = () => {
      holding = true;
      last = 0;
      button.classList.add("holding");
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(tick);
    };
    const stop = () => {
      holding = false;
      button.classList.remove("holding");
    };
    button.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      button.setPointerCapture(e.pointerId);
      start();
    });
    button.addEventListener("pointerup", stop);
    button.addEventListener("pointercancel", stop);
    button.addEventListener("keydown", (e) => {
      if ((e.key === " " || e.key === "Enter") && !e.repeat) {
        e.preventDefault();
        start();
      }
    });
    button.addEventListener("keyup", (e) => {
      if (e.key === " " || e.key === "Enter") stop();
    });
    return {
      reset() {
        p = 0;
        last = 0;
        fp.set(0);
      },
    };
  }

  const KEY = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 1.75a5.25 5.25 0 0 1 1.5 10.28v1.72h1.9a.6.6 0 0 1 .6.6v1.3a.6.6 0 0 1-.6.6h-1.9v.75h1.4a.6.6 0 0 1 .6.6v1.3a.6.6 0 0 1-.6.6h-1.4v.6a.8.8 0 0 1-.23.56l-.7.7a.8.8 0 0 1-1.14 0l-.7-.7a.8.8 0 0 1-.23-.56v-8.15A5.25 5.25 0 0 1 12 1.75Zm0 2.25a1.75 1.75 0 1 0 0 3.5 1.75 1.75 0 0 0 0-3.5Z"/></svg>`;
  const PUZZLE = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 3a2 2 0 0 1 2 2v1h3a1 1 0 0 1 1 1v3h1a2 2 0 1 1 0 4h-1v3a1 1 0 0 1-1 1h-3v-1a2 2 0 1 0-4 0v1H5a1 1 0 0 1-1-1v-3h1a2 2 0 1 0 0-4H4V7a1 1 0 0 1 1-1h3V5a2 2 0 0 1 2-2Z"/></svg>`;
  const MAIL = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5.5" width="18" height="13" rx="2.5"/><path d="m4 7 8 6 8-6"/></svg>`;
  const PERSON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="8.5" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/></svg>`;
  const EYE = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3"/></svg>`;
  const EYE_OFF = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3"/><path d="m4 4 16 16"/></svg>`;
  // One login from each password manager, so the demo shows what mixing them looks like: an initial
  // with its manager's tile, as the real menu and popup show logins from more than one account.
  // The glyphs are the extension's own (src/ui/icons.ts), not the providers' logos.
  const PROVIDERS = {
    apple: {
      label: "Apple Passwords",
      glyph:
        "M12 1.75a5.25 5.25 0 0 1 1.5 10.28v1.72h1.9a.6.6 0 0 1 .6.6v1.3a.6.6 0 0 1-.6.6h-1.9v.75h1.4a.6.6 0 0 1 .6.6v1.3a.6.6 0 0 1-.6.6h-1.4v.6a.8.8 0 0 1-.23.56l-.7.7a.8.8 0 0 1-1.14 0l-.7-.7a.8.8 0 0 1-.23-.56v-8.15A5.25 5.25 0 0 1 12 1.75Zm0 2.25a1.75 1.75 0 1 0 0 3.5 1.75 1.75 0 0 0 0-3.5Z",
    },
    bitwarden: {
      label: "Bitwarden",
      glyph:
        "M11.7 2.08a.75.75 0 0 1 .6 0l7.5 3.2a.75.75 0 0 1 .45.69v5.3c0 4.9-3.2 9.05-8.05 10.67a.75.75 0 0 1-.4 0C6.95 20.32 3.75 16.17 3.75 11.27v-5.3a.75.75 0 0 1 .45-.69l7.5-3.2Z",
    },
  };
  const LOGINS = [
    { user: "jane@example.com", from: "apple" },
    { user: "jane.ops@example.com", from: "bitwarden" },
  ];
  const sourceTile = (id, cls = "dm-src") =>
    `<span class="${cls} dm-tile-${id}" role="img" aria-label="${PROVIDERS[id].label}" title="From ${PROVIDERS[id].label}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${PROVIDERS[id].glyph}"/></svg></span>`;
  const avatar = ({ user, from }) => `<span class="dm-av">${user[0].toUpperCase()}${sourceTile(from)}</span>`;
  const pick = (s) => s[Math.floor(Math.random() * s.length)];
  // Illustrative only: the real addresses and passwords come from iCloud and the extension.
  const hideMyEmail = () =>
    `${pick(["quiet", "brisk", "amber", "lunar", "mossy", "swift", "civic", "olive"])}.${pick(["otter", "fern", "quill", "harbor", "maple", "comet", "pebble", "heron"])}_${Math.random().toString(36).slice(2, 4)}@icloud.com`;
  const strongPassword = () => {
    const a = "abcdefghijkmnopqrstuvwxyz";
    const chars = Array.from({ length: 18 }, () => pick(a));
    chars[Math.floor(Math.random() * 18)] = pick("23456789");
    const up = Math.floor(Math.random() * 18);
    chars[up] = chars[up].toUpperCase();
    const s = chars.join("");
    return `${s.slice(0, 6)}-${s.slice(6, 12)}-${s.slice(12)}`;
  };
  // Keep the first group of a suggested password readable and mask the rest.
  const maskPw = (pw) => {
    const groups = pw.split("-");
    if (groups.length > 1) return [groups[0], ...groups.slice(1).map((g) => "•".repeat(g.length))].join("-");
    return pw.slice(0, 6) + "•".repeat(pw.length - 6);
  };

  // The extension's settings, shared by every popup on the page and kept in this browser.
  const SETTINGS_KEY = "app-demo-settings";
  const settings = { inline: true, signup: true, hme: true, lockOnSleep: false };
  try {
    Object.assign(settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}"));
  } catch {}
  const TOGGLES = [
    ["inline", "When signing in", "saved passwords"],
    ["signup", "When signing up", "strong passwords and emails"],
    ["hme", "Hide My Email", "uses icloud.com"],
  ];
  function setSetting(key, value) {
    settings[key] = value;
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {}
    document.dispatchEvent(new CustomEvent("kit:settings", { detail: { key, value } }));
  }
  // The popup's settings part, as in the real popup: Suggestions, then Lock when my Mac locks and Lock.
  function settingsHTML() {
    const toggle = (k, label, detail) =>
      `<label class="dm-pop-toggle"><input type="checkbox" data-setting="${k}" ${settings[k] ? "checked" : ""} /><span>${label}${detail ? `<small>${detail}</small>` : ""}</span></label>`;
    return `<div class="dm-pop-sec"><h5>Suggestions</h5>${TOGGLES.map(([k, l, d]) => toggle(k, l, d)).join("")}</div>
      <div class="dm-pop-foot">${toggle("lockOnSleep", "Lock when my Mac locks", "")}<button type="button" class="dm-pop-lock">Lock</button></div>`;
  }
  function bindSettings(el) {
    el.querySelectorAll("input[data-setting]").forEach((i) => {
      i.addEventListener("change", () => setSetting(i.dataset.setting, i.checked));
    });
  }
  const wait = (ms) => new Promise((r) => setTimeout(r, reduce ? 0 : ms));
  let uid = 0;
  // The demo's styles, copied from shared.css into its shadow root.
  let sheet;
  const demoSheet = () => {
    if (!sheet) {
      sheet = new CSSStyleSheet();
      const src = [...document.styleSheets].find((s) => s.href?.endsWith("/shared.css"));
      sheet.replaceSync(src ? [...src.cssRules].map((r) => r.cssText).join("\n") : "");
    }
    return sheet;
  };

  // The interactive browser: a pretend site with a sign-in page and, optionally, a create-account page.
  // Options: locked (start locked), mode ("signin" | "signup"), switchable (show both), hint.
  // Emits demo:ask, demo:unlock, demo:lock, demo:mode and demo:fill (detail.kind: login | hme | me | strong).
  // There's no submit button, so nothing on the page reads as a real form to send.
  // Intro: the card's fields hop one after another on load.
  // Frameless: just the site's card, with no browser around it. The page then passes its own
  // extension button and popup element, and optionally a footer for the popup.
  function demo(
    root,
    {
      locked = false,
      mode = "signin",
      switchable = false,
      hint = "Click the field to try it",
      frameless = false,
      intro = false,
      toolbarButton = null,
      popupEl = null,
      popupFooter = () => "",
    } = {},
  ) {
    const id = `dm${++uid}`;
    // A closed shadow root keeps the pretend fields out of reach of real password managers
    // (Apple's included), so they don't offer to fill the demo. The page can still add its own
    // elements to the card: children of root show up at the end of it.
    const shadow = root.attachShadow({ mode: "closed" });
    shadow.adoptedStyleSheets = [demoSheet()];
    const box = document.createElement("div");
    box.className = frameless ? "dm frameless" : "dm";
    // Intro: the card's fields hop one after another on load. The class goes once they're done, so
    // fields that are hidden and shown again later don't replay it.
    if (intro && !reduce) {
      box.classList.add("intro");
      setTimeout(() => box.classList.remove("intro"), 2500);
    }
    shadow.append(box);
    const CARD = `
            <div class="dm-form">
              ${switchable ? `<div class="dm-switch" role="tablist" aria-label="Page"><button type="button" role="tab" data-m="signin">Sign in</button><button type="button" role="tab" data-m="signup">Create account</button></div>` : ""}
              <div class="dm-h"></div>
              <label class="dm-l" for="${id}-a">Email</label>
              <input class="dm-email" id="${id}-a" type="text" role="combobox" aria-expanded="false" aria-controls="${id}-menu" aria-autocomplete="list" placeholder="you@example.com" autocomplete="off" data-1p-ignore data-lpignore="true" data-bwignore data-form-type="other" data-protonpass-ignore="true" />
              <div class="dm-hint" part="hint">${hint}</div>
              <label class="dm-l" for="${id}-b">Password</label>
              <div class="dm-pass-wrap"><input class="dm-pass masked" id="${id}-b" type="text" role="combobox" aria-expanded="false" aria-controls="${id}-menu" aria-autocomplete="list" spellcheck="false" autocapitalize="off" autocomplete="off" data-1p-ignore data-lpignore="true" data-bwignore data-form-type="other" data-protonpass-ignore="true" /><button type="button" class="dm-eye" aria-label="Show password" aria-pressed="false">${EYE}</button></div>
              <div class="dm-repeat" hidden>
                <label class="dm-l" for="${id}-c">Repeat password</label>
                <input class="dm-pass2 masked" id="${id}-c" type="text" spellcheck="false" autocapitalize="off" autocomplete="off" data-1p-ignore data-lpignore="true" data-bwignore data-form-type="other" data-protonpass-ignore="true" />
              </div>
              <div class="dm-menu" id="${id}-menu" hidden></div>
            </div>
            <slot></slot>`;
    box.innerHTML =
      (frameless
        ? `<div class="dm-card" part="card"><div class="dm-site"><span aria-hidden="true"></span>example.com</div>${CARD}</div>`
        : `
      <div class="dm-win">
        <div class="dm-bar">
          <div class="dm-lights" aria-hidden="true"><i></i><i></i><i></i></div>
          <div class="dm-omni"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1a3.5 3.5 0 0 0-3.5 3.5V6H4a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V7a1 1 0 0 0-1-1h-.5V4.5A3.5 3.5 0 0 0 8 1Zm2 5H6V4.5a2 2 0 1 1 4 0Z"/></svg><span class="dm-url">example.com/login</span></div>
          <span class="dm-tb" aria-hidden="true">${PUZZLE}</span>
          <button class="dm-tb dm-ext" type="button" aria-expanded="false" aria-controls="${id}-pop" title="Better Passwords"><img src="${ICON}" alt="Better Passwords" /></button>
          <div class="dm-popup" id="${id}-pop" hidden></div>
        </div>
        <div class="dm-page">
          <div class="dm-site"><span aria-hidden="true"></span>example.com</div>
          <div class="dm-card" part="card">${CARD}
          </div>
        </div>
      </div>`) +
      `
      <div class="dm-mac dm-ask" hidden>
        <div class="dm-mac-head"><span class="dm-mac-icon">${KEY}</span><b>Passwords</b><small>now</small></div>
        <p>Enter this code in your browser</p>
        <div class="dm-mac-digits"></div>
      </div>`;

    const $ = (s) => box.querySelector(s);
    const email = $(".dm-email"),
      pass = $(".dm-pass"),
      pass2 = $(".dm-pass2"),
      repeat = $(".dm-repeat"),
      menu = $(".dm-menu"),
      hintEl = $(".dm-hint");
    const ext = toolbarButton ?? $(".dm-ext"),
      popup = popupEl ?? $(".dm-popup"),
      ask = $(".dm-ask");
    const digits = roller($(".dm-mac-digits"));
    const logins = [...LOGINS];
    const recent = []; // new passwords not yet confirmed as saved, listed in the popup like the real one
    let isLocked = locked,
      sel = 0,
      rows = [],
      field = email,
      hme = hideMyEmail(),
      strong = strongPassword();
    const emit = (name, detail) => root.dispatchEvent(new CustomEvent(name, { bubbles: true, detail }));

    const closeMenu = () => {
      menu.hidden = true;
      [email, pass].forEach((f) => {
        f.setAttribute("aria-expanded", "false");
        f.removeAttribute("aria-activedescendant");
      });
    };
    const select = (i) => {
      if (!rows.length) return;
      sel = (i + rows.length) % rows.length;
      rows.forEach((r, j) => {
        r.setAttribute("aria-selected", String(j === sel));
      });
      field.setAttribute("aria-activedescendant", rows[sel].id);
    };
    // Measured against the card (the menu's positioned container), since the field may sit in a wrapper.
    const place = () => {
      menu.style.top = `${field.getBoundingClientRect().bottom - $(".dm-card").getBoundingClientRect().top + 6}px`;
    };
    const showPanel = (el) => {
      el.hidden = false;
      requestAnimationFrame(() => el.classList.add("on"));
    };
    const hidePanel = (el) => {
      el.classList.remove("on");
      setTimeout(() => (el.hidden = true), 300);
    };

    // What the menu offers for the focused field, given the extension's settings.
    function items() {
      if (mode === "signin")
        return settings.inline
          ? [
              ...logins.map((l) => ({
                kind: "login",
                icon: avatar(l),
                title: l.user,
                sub: "example.com",
                value: l.user,
              })),
              { sep: true },
              ...Object.values(PROVIDERS).map((p) => ({ kind: "app", title: `Open ${p.label}` })),
            ]
          : [];
      if (field === email) {
        const list = [];
        if (settings.hme) list.push({ kind: "hme", icon: MAIL, title: "Hide My Email", sub: hme, value: hme });
        if (settings.signup)
          list.push({
            kind: "me",
            icon: PERSON,
            title: "jane@example.com",
            sub: "From your contact card",
            value: "jane@example.com",
          });
        if (settings.hme) list.push({ sep: true }, { kind: "another", title: "Try Another Address" });
        return list;
      }
      return settings.signup
        ? [
            { kind: "strong", icon: KEY, title: "Use Strong Password", value: strong, masked: true },
            {
              kind: "strong",
              icon: KEY,
              title: "No Special Characters",
              value: strong.replaceAll("-", ""),
              masked: true,
            },
          ]
        : [];
    }

    function renderRows() {
      menu.setAttribute("role", "listbox");
      const list = items();
      menu.innerHTML = list
        .map((it, i) =>
          it.sep
            ? "<hr />"
            : `<div class="dm-row${it.icon ? "" : " plain"}" role="option" id="${id}-o${i}" data-i="${i}">${it.icon ?? ""}<div><b>${it.title}</b>${it.masked ? `<small class="dm-pw" data-full="${it.value}">${maskPw(it.value)}</small>` : it.sub ? `<small>${it.sub}</small>` : ""}</div>${it.masked ? `<span class="dm-peek" aria-hidden="true">${EYE}</span>` : ""}</div>`,
        )
        .join("");
      // Hovering a suggestion's eye shows the whole password, like the real menu.
      menu.querySelectorAll(".dm-peek").forEach((eye) => {
        const pw = eye.parentElement.querySelector(".dm-pw");
        eye.addEventListener("mouseenter", () => (pw.textContent = pw.dataset.full));
        eye.addEventListener("mouseleave", () => (pw.textContent = maskPw(pw.dataset.full)));
      });
      rows = [...menu.querySelectorAll(".dm-row")];
      rows.forEach((r, i) => {
        const it = list[Number(r.dataset.i)];
        r.addEventListener("mouseenter", () => select(i));
        r.addEventListener("mousedown", (e) => {
          e.preventDefault();
          choose(it);
        });
      });
      select(0);
    }

    function renderUnlock() {
      menu.removeAttribute("role");
      rows = [];
      menu.innerHTML = `
        <div class="dm-unlock">
          <b>Unlock Better Passwords</b>
          <p>Type the six digits your Mac is showing. Once, until you quit.</p>
          <input class="dm-code" inputmode="numeric" maxlength="6" autocomplete="off" aria-label="Six digits from your Mac" placeholder="······" />
          <div class="dm-unlock-foot">
            <button type="button" class="dm-touch"><svg class="fp"></svg><span>Hold for Touch ID</span></button>
            <button type="button" class="dm-auto">Type it for me</button>
          </div>
        </div>`;
      const code = menu.querySelector(".dm-code");
      code.addEventListener("input", () => {
        code.value = code.value.replace(/\D/g, "").slice(0, 6);
        if (code.value.length < 6) return;
        if (code.value === digits.code) unlock();
        else {
          code.classList.remove("shake");
          void code.offsetWidth;
          code.classList.add("shake");
          code.value = "";
        }
      });
      code.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          closeMenu();
          field.focus();
        }
      });
      menu.querySelector(".dm-auto").addEventListener("click", async () => {
        for (const ch of digits.code) {
          code.value += ch;
          await wait(90);
        }
        unlock();
      });
      const btn = menu.querySelector(".dm-touch");
      hold(btn, print(btn.querySelector("svg")), unlock, { duration: 800 });
      setTimeout(() => code.focus(), 60);
    }

    function openMenu(f) {
      if (f.value) return;
      const same = field === f && !menu.hidden;
      field = f;
      // Nothing to offer here (a setting is off): no menu, like the real extension.
      if (!items().length) return closeMenu();
      hintEl.hidden = true;
      place();
      if (isLocked) {
        if (!same || !menu.querySelector(".dm-unlock")) {
          renderUnlock();
          digits.set();
          showPanel(ask);
          emit("demo:ask");
        }
      } else if (!same || !rows.length) renderRows();
      menu.hidden = false;
      f.setAttribute("aria-expanded", "true");
    }

    function unlock() {
      if (!isLocked) return;
      isLocked = false;
      hidePanel(ask);
      renderRows();
      menu.hidden = false;
      field.focus();
      emit("demo:unlock");
    }

    function lock() {
      isLocked = true;
      closeMenu();
      emit("demo:lock");
    }

    function choose(it) {
      if (it.kind === "another") {
        hme = hideMyEmail();
        renderRows();
        return;
      }
      if (it.kind === "app") {
        closeMenu();
        return;
      }
      fill(it.kind, it.value);
    }

    function fill(kind, value) {
      closeMenu();
      setPopup(false);
      if (kind === "login") {
        email.value = value;
        pass.value = "correct-horse-battery";
      } else if (kind === "strong") {
        pass.value = value;
        pass2.value = value;
        flash(pass, pass2);
        recent.unshift({ user: email.value || "example.com", pw: value });
      } else email.value = value;
      emit("demo:fill", { kind });
      if (mode === "signup" && kind !== "strong" && !pass.value && shadow.activeElement === email)
        setTimeout(() => pass.focus(), 350);
    }

    // Fields lit up the moment they're filled, like the browser's own autofill.
    const flash = (...fs) =>
      fs.forEach((f) => {
        f.classList.remove("filled");
        void f.offsetWidth;
        f.classList.add("filled");
      });

    function reset() {
      email.value = "";
      pass.value = "";
      pass2.value = "";
      [email, pass, pass2].forEach((f) => {
        f.classList.remove("filled");
      });
      hme = hideMyEmail();
      strong = strongPassword();
    }

    const eye = $(".dm-eye");
    const showPass = (on) => {
      pass.classList.toggle("masked", !on);
      pass2.classList.toggle("masked", !on);
      eye.innerHTML = on ? EYE_OFF : EYE;
      eye.setAttribute("aria-pressed", String(on));
      eye.setAttribute("aria-label", on ? "Hide password" : "Show password");
    };
    eye.addEventListener("click", () => showPass(pass.classList.contains("masked")));
    function setMode(m) {
      mode = m;
      reset();
      showPass(false);
      eye.hidden = m !== "signup";
      repeat.hidden = m !== "signup";
      closeMenu();
      $(".dm-h").textContent = m === "signin" ? "Sign in" : "Create your account";
      const url = $(".dm-url");
      if (url) url.textContent = m === "signin" ? "example.com/login" : "example.com/signup";
      box.querySelectorAll(".dm-switch button").forEach((b) => {
        b.setAttribute("aria-selected", String(b.dataset.m === m));
      });
      emit("demo:mode", { mode: m });
    }

    // Mirrors the real popup: the site's logins, recent passwords, each password manager, then settings.
    function renderPopup() {
      popup.innerHTML = isLocked
        ? `<div class="dm-pop-h">Better Passwords</div><p class="dm-pop-p">Locked. Click a field on the page to unlock it.</p>`
        : `<div class="dm-pop-h">example.com</div>
           <ul class="dm-pop-logins">${logins.map((l) => `<li><button type="button" class="dm-pop-row" data-user="${l.user}" title="Fill ${l.user}">${avatar(l)}${l.user}</button></li>`).join("")}</ul>
           ${recent.length ? `<div class="dm-pop-sec"><h5>Recent passwords</h5><ul class="dm-pop-logins">${recent.map((r, i) => `<li class="dm-pop-recent"><span>${r.user}</span><button type="button" data-copy="${i}">Copy</button></li>`).join("")}</ul><p class="dm-pop-hint">New passwords from this session, in case one wasn't saved.</p></div>` : ""}
           ${Object.values(PROVIDERS)
             .map((p) => `<button type="button" class="dm-pop-link">Open ${p.label}</button>`)
             .join("")}
           ${settingsHTML()}`;
      popup.insertAdjacentHTML("beforeend", popupFooter());
      bindSettings(popup);
      popup.querySelectorAll(".dm-pop-row").forEach((b) => {
        b.addEventListener("click", () => {
          email.value = "";
          pass.value = "";
          fill("login", b.dataset.user);
        });
      });
      popup.querySelectorAll("[data-copy]").forEach((b) => {
        b.addEventListener("click", () => {
          b.textContent = "Copied";
        });
      });
      popup.querySelector(".dm-pop-lock")?.addEventListener("click", () => {
        setPopup(false);
        lock();
      });
    }
    const setPopup = (open) => {
      popup.hidden = !open;
      ext.setAttribute("aria-expanded", String(open));
      if (open) renderPopup();
    };

    for (const f of [email, pass]) {
      f.addEventListener("focus", () => openMenu(f));
      f.addEventListener("click", () => openMenu(f));
      f.addEventListener("input", closeMenu);
      f.addEventListener("keydown", (e) => {
        if (menu.hidden) {
          if (e.key === "ArrowDown") {
            openMenu(f);
            e.preventDefault();
          }
          return;
        }
        if (e.key === "Escape") return closeMenu();
        if (!rows.length) return;
        if (e.key === "ArrowDown") {
          select(sel + 1);
          e.preventDefault();
        } else if (e.key === "ArrowUp") {
          select(sel - 1);
          e.preventDefault();
        } else if (e.key === "Enter") {
          rows[sel].dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
          e.preventDefault();
        }
      });
    }
    box.querySelectorAll(".dm-switch button").forEach((b) => {
      b.addEventListener("click", () => setMode(b.dataset.m));
    });
    ext.addEventListener("click", (e) => {
      e.stopPropagation();
      setPopup(popup.hidden);
    });
    // Outside the shadow root, a click in the card reports root as its target.
    document.addEventListener("pointerdown", (e) => {
      if (!popup.contains(e.target) && !ext.contains(e.target)) setPopup(false);
      if (e.target !== root) closeMenu();
    });
    shadow.addEventListener("pointerdown", (e) => {
      if (!menu.contains(e.target) && e.target !== email && e.target !== pass) closeMenu();
    });
    // A setting changed (here or in another popup): the next menu reflects it.
    document.addEventListener("kit:settings", closeMenu);

    setMode(mode);
    hintEl.style.top = `${email.offsetTop}px`;
    // For scripted tours: open a field's menu, pick a row, find things to point at.
    const pickRow = (i) => rows[i]?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    const target = (what) =>
      ({
        email,
        pass,
        signup: $('.dm-switch [data-m="signup"]'),
        signin: $('.dm-switch [data-m="signin"]'),
        row0: rows[0],
      })[what];
    root.demo = {
      lock,
      unlock,
      reset,
      setMode,
      open: (w) => openMenu(w === "pass" ? pass : email),
      pick: pickRow,
      target,
      close: closeMenu,
      get mode() {
        return mode;
      },
      get locked() {
        return isLocked;
      },
    };
    return root.demo;
  }

  // Mark the navigation tab for the section currently on screen.
  return {
    reduce,
    reveal,
    roller,
    randomCode,
    spaced,
    print,
    hold,
    demo,
    hideMyEmail,
    strongPassword,
    settings,
    setSetting,
    settingsHTML,
    bindSettings,
  };
})();
