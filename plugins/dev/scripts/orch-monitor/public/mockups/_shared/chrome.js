/*
 * Mockup harness chrome — floating system switcher + global keybindings.
 *
 * Two axes persist to localStorage under "catalyst.mockup.prefs":
 *   - system:  operator-console | precision-instrument  (html[data-system])
 *   - theme:   dark | light                             (html[data-theme])
 *
 * System resolution priority: window.__catalystMockupPrefs (set by pre-paint
 * bootstrap) > URL query string > localStorage > default. URL stays clean —
 * the default value is never written as a query param.
 *
 * Global keybindings (see README.md for the full table):
 *   g h/d/w/c/b/v/t/r  — navigate to the matching mockup page
 *   ⇧D                 — toggle theme (dark ↔ light)
 *   .                  — cycle system (same as pill click)
 *   p                  — cycle palette (no-op until palettes.css ships)
 *   /                  — focus search input if present
 *   ?                  — open keybinding cheat sheet overlay
 *   Escape             — close any overlay / popover
 *
 * The module is browser-first. A CommonJS export guard at the bottom exposes
 * pure helpers for Bun unit tests — DOM side effects are wrapped in a
 * `typeof window !== "undefined"` block so the module can be required in Node.
 */
(function () {
  const LS_KEY = "catalyst.mockup.prefs";
  const DEFAULTS = { system: "operator-console", theme: "dark" };
  const SYSTEMS = ["operator-console", "precision-instrument"];
  const THEMES = ["dark", "light"];
  const SYSTEM_LABELS = {
    "operator-console": "Operator Console",
    "precision-instrument": "Precision Instrument",
  };

  // Vim-style g-prefix navigation table. Values are file names under ./mockups/.
  // Pages that don't exist yet will 404 — that's intentional; new mockups just
  // need to match these names to be reachable via the keyboard.
  const GNAV = {
    h: "index.html",
    d: "orch.html",
    w: "worker.html",
    c: "comms.html",
    b: "briefing.html",
    v: "agent-graph.html",
    t: "todos.html",
    r: "brand.html",
  };

  const GPREFIX_TIMEOUT_MS = 1500;

  // Human-readable binding list powering the cheat-sheet overlay (`?`).
  const CHEATSHEET_BINDINGS = [
    { section: "Navigation", rows: [
      { keys: ["g", "h"], label: "Home (gallery index)" },
      { keys: ["g", "d"], label: "Orchestrator dashboard" },
      { keys: ["g", "w"], label: "Worker" },
      { keys: ["g", "c"], label: "Comms" },
      { keys: ["g", "b"], label: "Briefing" },
      { keys: ["g", "v"], label: "Agent graph" },
      { keys: ["g", "t"], label: "Todos" },
      { keys: ["g", "r"], label: "Brand showcase" },
    ]},
    { section: "Appearance", rows: [
      { keys: ["⇧", "D"], label: "Toggle theme (dark / light)" },
      { keys: ["."],      label: "Cycle system (operator / precision)" },
      { keys: ["p"],      label: "Cycle palette" },
    ]},
    { section: "Utility", rows: [
      { keys: ["/"],   label: "Focus search" },
      { keys: ["?"],   label: "Open this cheat sheet" },
      { keys: ["Esc"], label: "Close overlays" },
    ]},
  ];

  // ----- Pure helpers (no DOM access) -----

  function isTypingTarget(el) {
    if (!el || typeof el !== "object") return false;
    const tag = typeof el.tagName === "string" ? el.tagName.toUpperCase() : "";
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
    return Boolean(el.isContentEditable);
  }

  function shouldIgnoreKey(ev) {
    if (!ev) return false;
    return isTypingTarget(ev.target);
  }

  function nextSystem(current) {
    const idx = SYSTEMS.indexOf(current);
    if (idx === -1) return SYSTEMS[0];
    return SYSTEMS[(idx + 1) % SYSTEMS.length];
  }

  function nextTheme(current) {
    const idx = THEMES.indexOf(current);
    if (idx === -1) return THEMES[0];
    return THEMES[(idx + 1) % THEMES.length];
  }

  function resolveGNav(key) {
    if (typeof key !== "string" || key.length === 0) return undefined;
    return Object.prototype.hasOwnProperty.call(GNAV, key) ? GNAV[key] : undefined;
  }

  // ----- CommonJS export guard (used by Bun unit tests; skipped in browser) -----

  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      SYSTEMS,
      THEMES,
      GNAV,
      isTypingTarget,
      shouldIgnoreKey,
      nextSystem,
      nextTheme,
      resolveGNav,
    };
  }

  // ----- Browser DOM wiring below this line -----

  if (typeof window === "undefined" || typeof document === "undefined") return;

  function readPrefs() {
    const bootstrapped = window.__catalystMockupPrefs;
    const url = new URLSearchParams(window.location.search);
    let stored = {};
    try {
      stored = JSON.parse(window.localStorage.getItem(LS_KEY) || "{}");
    } catch (_e) {
      stored = {};
    }
    const systemCandidate =
      (bootstrapped && bootstrapped.system) ||
      url.get("system") ||
      stored.system ||
      DEFAULTS.system;
    const themeCandidate =
      (bootstrapped && bootstrapped.theme) || stored.theme || DEFAULTS.theme;
    return {
      system: SYSTEMS.includes(systemCandidate) ? systemCandidate : DEFAULTS.system,
      theme: THEMES.includes(themeCandidate) ? themeCandidate : DEFAULTS.theme,
    };
  }

  function apply(prefs) {
    document.documentElement.setAttribute("data-system", prefs.system);
    document.documentElement.setAttribute("data-theme", prefs.theme);
  }

  function persist(prefs) {
    try {
      window.localStorage.setItem(LS_KEY, JSON.stringify(prefs));
    } catch (_e) {
      /* localStorage unavailable — URL still round-trips for system */
    }
    const url = new URL(window.location.href);
    if (prefs.system !== DEFAULTS.system) {
      url.searchParams.set("system", prefs.system);
    } else {
      url.searchParams.delete("system");
    }
    window.history.replaceState({}, "", url.toString());
  }

  function buildPopover(prefs, onChange) {
    const popover = document.createElement("div");
    popover.className = "mockup-chrome__popover";
    popover.hidden = true;
    popover.setAttribute("role", "group");
    popover.setAttribute("aria-label", "Visual system");

    const label = document.createElement("span");
    label.className = "eyebrow mockup-chrome__group-label";
    label.textContent = "System";
    popover.appendChild(label);

    const options = document.createElement("div");
    options.className = "mockup-chrome__options";
    SYSTEMS.forEach((value) => {
      const option = document.createElement("label");
      option.className = "mockup-chrome__option";
      if (value === prefs.system) {
        option.classList.add("mockup-chrome__option--checked");
      }

      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "system";
      radio.value = value;
      radio.checked = value === prefs.system;
      radio.setAttribute("data-control", "system");
      radio.addEventListener("change", () => onChange(value));

      const text = document.createElement("span");
      text.textContent = SYSTEM_LABELS[value];

      option.appendChild(radio);
      option.appendChild(text);
      options.appendChild(option);
    });
    popover.appendChild(options);

    return popover;
  }

  function buildPill(prefs) {
    const pill = document.createElement("button");
    pill.type = "button";
    pill.className = "mockup-chrome__pill";
    pill.setAttribute("aria-haspopup", "true");
    pill.setAttribute("aria-expanded", "false");
    pill.setAttribute("aria-label", "Open system switcher");

    const label = document.createElement("span");
    label.className = "mockup-chrome__pill-label";
    label.textContent = "System";

    const value = document.createElement("span");
    value.className = "mockup-chrome__pill-value";
    value.textContent = SYSTEM_LABELS[prefs.system];

    const caret = document.createElement("span");
    caret.className = "mockup-chrome__pill-caret";
    caret.setAttribute("aria-hidden", "true");

    pill.appendChild(label);
    pill.appendChild(value);
    pill.appendChild(caret);
    return pill;
  }

  // ----- Cheat sheet overlay -----

  let cheatSheetEl = null;

  function buildCheatSheet() {
    const root = document.createElement("div");
    root.className = "mockup-cheatsheet";
    root.hidden = true;
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("aria-label", "Keybinding cheat sheet");

    const backdrop = document.createElement("div");
    backdrop.className = "mockup-cheatsheet__backdrop";
    backdrop.setAttribute("aria-hidden", "true");

    const modal = document.createElement("div");
    modal.className = "mockup-cheatsheet__modal";
    modal.tabIndex = -1;

    const header = document.createElement("header");
    header.className = "mockup-cheatsheet__header";
    const heading = document.createElement("h2");
    heading.className = "mockup-cheatsheet__title";
    heading.textContent = "Keybindings";
    const hint = document.createElement("span");
    hint.className = "mockup-cheatsheet__hint";
    hint.textContent = "Esc to close";
    header.appendChild(heading);
    header.appendChild(hint);
    modal.appendChild(header);

    CHEATSHEET_BINDINGS.forEach(({ section, rows }) => {
      const sec = document.createElement("section");
      sec.className = "mockup-cheatsheet__section";
      const label = document.createElement("span");
      label.className = "eyebrow mockup-cheatsheet__section-label";
      label.textContent = section;
      sec.appendChild(label);

      const list = document.createElement("ul");
      list.className = "mockup-cheatsheet__list";
      rows.forEach(({ keys, label: rowLabel }) => {
        const item = document.createElement("li");
        item.className = "mockup-cheatsheet__row";
        const combo = document.createElement("span");
        combo.className = "mockup-cheatsheet__keys";
        keys.forEach((k, i) => {
          const kbd = document.createElement("kbd");
          kbd.className = "mockup-cheatsheet__kbd";
          kbd.textContent = k;
          combo.appendChild(kbd);
          if (i < keys.length - 1) {
            const sep = document.createElement("span");
            sep.className = "mockup-cheatsheet__sep";
            sep.setAttribute("aria-hidden", "true");
            sep.textContent = " then ";
            combo.appendChild(sep);
          }
        });
        const desc = document.createElement("span");
        desc.className = "mockup-cheatsheet__label";
        desc.textContent = rowLabel;
        item.appendChild(combo);
        item.appendChild(desc);
        list.appendChild(item);
      });
      sec.appendChild(list);
      modal.appendChild(sec);
    });

    root.appendChild(backdrop);
    root.appendChild(modal);

    backdrop.addEventListener("click", () => setCheatSheetOpen(false));

    return root;
  }

  function ensureCheatSheet() {
    if (cheatSheetEl && document.body.contains(cheatSheetEl)) return cheatSheetEl;
    cheatSheetEl = buildCheatSheet();
    document.body.appendChild(cheatSheetEl);
    return cheatSheetEl;
  }

  function isCheatSheetOpen() {
    return Boolean(cheatSheetEl && cheatSheetEl.hidden === false);
  }

  function setCheatSheetOpen(open) {
    const el = ensureCheatSheet();
    el.hidden = !open;
    if (open) {
      const modal = el.querySelector(".mockup-cheatsheet__modal");
      if (modal && typeof modal.focus === "function") modal.focus();
    }
  }

  // ----- Mount -----

  function mount(prefs) {
    if (document.querySelector(".mockup-chrome")) return null;

    const state = { ...prefs };
    const root = document.createElement("div");
    root.className = "mockup-chrome";

    const pill = buildPill(state);
    const valueEl = pill.querySelector(".mockup-chrome__pill-value");

    const handleSystemChange = (system) => {
      if (!SYSTEMS.includes(system)) return;
      state.system = system;
      apply(state);
      persist(state);
      valueEl.textContent = SYSTEM_LABELS[system];
      root
        .querySelectorAll(".mockup-chrome__option")
        .forEach((el) => el.classList.remove("mockup-chrome__option--checked"));
      const checkedInput = root.querySelector(`.mockup-chrome__option input[value="${system}"]`);
      if (checkedInput) {
        checkedInput.checked = true;
        if (checkedInput.parentElement) {
          checkedInput.parentElement.classList.add("mockup-chrome__option--checked");
        }
      }
    };

    const popover = buildPopover(state, handleSystemChange);

    const setPopoverOpen = (open) => {
      popover.hidden = !open;
      pill.setAttribute("aria-expanded", open ? "true" : "false");
    };

    pill.addEventListener("click", () => {
      setPopoverOpen(popover.hidden);
    });

    document.addEventListener("click", (ev) => {
      if (!root.contains(ev.target)) setPopoverOpen(false);
    });

    root.appendChild(pill);
    root.appendChild(popover);
    document.body.appendChild(root);

    return { state, handleSystemChange, setPopoverOpen };
  }

  // ----- Global keybinding handler -----

  function installKeybindings(controller) {
    let gPrefix = false;
    let gPrefixTimer = null;

    const clearGPrefix = () => {
      gPrefix = false;
      if (gPrefixTimer !== null) {
        clearTimeout(gPrefixTimer);
        gPrefixTimer = null;
      }
    };

    const cycleSystem = () => {
      if (!controller) return;
      const nxt = nextSystem(controller.state.system);
      controller.handleSystemChange(nxt);
    };

    const toggleTheme = () => {
      const current = document.documentElement.getAttribute("data-theme") || DEFAULTS.theme;
      const nxt = nextTheme(current);
      if (controller) controller.state.theme = nxt;
      document.documentElement.setAttribute("data-theme", nxt);
      const prefs = controller ? controller.state : { system: DEFAULTS.system, theme: nxt };
      persist(prefs);
    };

    const cyclePalette = () => {
      // Reserved — palettes.css does not exist yet. When a palette axis lands,
      // route its cycle through here so the pill can pick up the change.
    };

    const focusSearch = () => {
      const input = document.querySelector(
        'input[data-search], input[type="search"]',
      );
      if (input && typeof input.focus === "function") input.focus();
    };

    document.addEventListener("keydown", (ev) => {
      // Escape always fires so overlays can close even when something is focused.
      if (ev.key === "Escape") {
        if (isCheatSheetOpen()) {
          setCheatSheetOpen(false);
          ev.preventDefault();
          return;
        }
        if (controller) controller.setPopoverOpen(false);
        clearGPrefix();
        return;
      }

      if (shouldIgnoreKey(ev)) return;

      // Ignore modified shortcuts (browser/OS keep their own bindings).
      const hasModifier = ev.ctrlKey || ev.metaKey || ev.altKey;

      if (gPrefix) {
        clearGPrefix();
        if (hasModifier) return;
        const path = resolveGNav(ev.key);
        if (path) {
          ev.preventDefault();
          window.location.href = "./" + path;
        }
        return;
      }

      if (!hasModifier && ev.key === "g") {
        gPrefix = true;
        gPrefixTimer = setTimeout(clearGPrefix, GPREFIX_TIMEOUT_MS);
        return;
      }

      // Shift+D — theme toggle.
      if (ev.shiftKey && !ev.ctrlKey && !ev.metaKey && !ev.altKey && ev.key === "D") {
        ev.preventDefault();
        toggleTheme();
        return;
      }

      if (hasModifier) return;

      if (ev.key === ".") {
        ev.preventDefault();
        cycleSystem();
        return;
      }
      if (ev.key === "p") {
        ev.preventDefault();
        cyclePalette();
        return;
      }
      if (ev.key === "/") {
        ev.preventDefault();
        focusSearch();
        return;
      }
      if (ev.key === "?") {
        ev.preventDefault();
        setCheatSheetOpen(!isCheatSheetOpen());
        return;
      }
    });
  }

  // ----- Boot -----

  const prefs = readPrefs();
  apply(prefs);
  persist(prefs);

  const boot = () => {
    const controller = mount(prefs);
    installKeybindings(controller);
  };

  if (document.readyState !== "loading") {
    boot();
  } else {
    document.addEventListener("DOMContentLoaded", boot);
  }
})();
