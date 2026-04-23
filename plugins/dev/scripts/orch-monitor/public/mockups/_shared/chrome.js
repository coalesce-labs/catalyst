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
 *   ⌘K / Ctrl K        — open command palette (CTL-166)
 *   Escape             — close any overlay / popover
 *
 * Topbar enhancement (CTL-166): once the page loads, chrome.js upgrades the
 * static `<header class="mockup-topbar">` by (a) turning the catalyst mark
 * into an `<a href="./index.html">`, (b) injecting a breadcrumb sourced from
 * `<meta name="mockup-breadcrumb">`, and (c) appending a ⌘K chip on the right
 * that opens a filterable palette modal.
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

  // CTL-166 — breadcrumb segments come from a per-page meta tag whose value
  // looks like "Monitor / orch-2026-04-22-3 / wave 2". Split on " / ", trim
  // each segment, and drop empties so an extra separator doesn't render a
  // ghost crumb.
  function parseBreadcrumb(value) {
    if (typeof value !== "string") return [];
    const trimmed = value.trim();
    if (trimmed.length === 0) return [];
    return trimmed
      .split("/")
      .map((segment) => segment.trim())
      .filter((segment) => segment.length > 0);
  }

  // CTL-166 — used to pick the right modifier glyph (⌘ vs Ctrl). Tests stub
  // this with a plain `{ platform, userAgent }` object so no real navigator
  // is required. Falls back to userAgent when platform is missing because
  // userAgentData / platform are spotty across browsers.
  function isMacPlatform(nav) {
    if (!nav || typeof nav !== "object") return false;
    const platform = typeof nav.platform === "string" ? nav.platform : "";
    if (platform.toLowerCase().indexOf("mac") !== -1) return true;
    const ua = typeof nav.userAgent === "string" ? nav.userAgent : "";
    return ua.toLowerCase().indexOf("mac") !== -1;
  }

  // CTL-166 — labels rendered in the palette and breadcrumb fallback. Keep in
  // sync with the cheatsheet's GNAV row labels.
  const GNAV_LABELS = {
    "index.html": "Home",
    "orch.html": "Orchestrator",
    "worker.html": "Worker",
    "comms.html": "Comms",
    "briefing.html": "Briefing",
    "agent-graph.html": "Agent graph",
    "todos.html": "Todos",
    "brand.html": "Brand showcase",
  };

  // CTL-166 — derive the static palette action list. `gnav` is injected so the
  // tests can pass the live GNAV table without reaching into module state.
  // Each action carries the keybinding hint that the cheatsheet already shows
  // so users learn the shortcut while filtering.
  function paletteActions(gnav) {
    const actions = [];
    Object.keys(gnav).forEach((key) => {
      const path = gnav[key];
      const label = GNAV_LABELS[path] || path;
      actions.push({
        id: "nav:" + path,
        group: "Navigate",
        label,
        hint: ["g", key],
        type: "nav",
        payload: { path },
      });
    });
    actions.push({
      id: "appearance:toggle-theme",
      group: "Appearance",
      label: "Toggle theme",
      hint: ["⇧", "D"],
      type: "appearance",
      payload: { action: "toggleTheme" },
    });
    actions.push({
      id: "appearance:cycle-system",
      group: "Appearance",
      label: "Cycle system",
      hint: ["."],
      type: "appearance",
      payload: { action: "cycleSystem" },
    });
    actions.push({
      id: "appearance:cycle-palette",
      group: "Appearance",
      label: "Cycle palette",
      hint: ["p"],
      type: "appearance",
      payload: { action: "cyclePalette" },
    });
    actions.push({
      id: "help:cheatsheet",
      group: "Help",
      label: "Open cheatsheet",
      hint: ["?"],
      type: "help",
      payload: { action: "openCheatsheet" },
    });
    return actions;
  }

  // CTL-166 — case-insensitive substring filter on `label`. No fuzzy matcher
  // by design; ticket says substring is good enough for v1.
  function filterPaletteActions(actions, query) {
    if (!Array.isArray(actions)) return [];
    const q = typeof query === "string" ? query.trim().toLowerCase() : "";
    if (q.length === 0) return actions.slice();
    return actions.filter((action) => {
      const label = action && typeof action.label === "string" ? action.label : "";
      return label.toLowerCase().indexOf(q) !== -1;
    });
  }

  // ----- CommonJS export guard (used by Bun unit tests; skipped in browser) -----

  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      SYSTEMS,
      THEMES,
      GNAV,
      GNAV_LABELS,
      isTypingTarget,
      shouldIgnoreKey,
      nextSystem,
      nextTheme,
      resolveGNav,
      parseBreadcrumb,
      isMacPlatform,
      paletteActions,
      filterPaletteActions,
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

  // ----- Topbar enhancement (CTL-166) -----
  //
  // The static markup ships with a `<span class="mockup-topbar__mark">` and a
  // `<span class="eyebrow">…</span>` per page. We turn the mark into a real
  // anchor and inject a breadcrumb sourced from `<meta name="mockup-breadcrumb">`
  // (or `window.__catalystMockupBreadcrumb` for pages that prefer to set it via
  // script). The original eyebrow is removed once the breadcrumb is rendered to
  // keep the topbar from showing the same label twice.

  function readBreadcrumbMeta() {
    if (typeof document === "undefined") return "";
    if (typeof window !== "undefined" && typeof window.__catalystMockupBreadcrumb === "string") {
      return window.__catalystMockupBreadcrumb;
    }
    const meta = document.querySelector('meta[name="mockup-breadcrumb"]');
    return meta && typeof meta.getAttribute === "function"
      ? meta.getAttribute("content") || ""
      : "";
  }

  function buildBreadcrumb(segments) {
    const nav = document.createElement("nav");
    nav.className = "mockup-topbar__crumb";
    nav.setAttribute("aria-label", "Breadcrumb");
    segments.forEach((segment, idx) => {
      if (idx > 0) {
        const sep = document.createElement("span");
        sep.className = "mockup-topbar__crumb-sep";
        sep.setAttribute("aria-hidden", "true");
        sep.textContent = "/";
        nav.appendChild(sep);
      }
      const span = document.createElement("span");
      span.className = "mockup-topbar__crumb-segment";
      span.textContent = segment;
      if (idx === segments.length - 1) {
        span.setAttribute("aria-current", "page");
      }
      nav.appendChild(span);
    });
    return nav;
  }

  function buildKeybindChip(palettePresenter) {
    const isMac = isMacPlatform(window.navigator || {});
    const button = document.createElement("button");
    button.type = "button";
    button.className = "mockup-topbar__chip";
    button.setAttribute("aria-label", "Open command palette");

    const keys = isMac ? ["⌘", "K"] : ["Ctrl", "K"];
    keys.forEach((k) => {
      const kbd = document.createElement("kbd");
      kbd.className = "mockup-topbar__chip-kbd";
      kbd.textContent = k;
      button.appendChild(kbd);
    });

    button.addEventListener("click", () => palettePresenter.toggle());
    return button;
  }

  function enhanceTopbar(palettePresenter) {
    const topbar = document.querySelector("header.mockup-topbar");
    if (!topbar) return;

    // Mark → anchor. Replace in-place so the existing CSS selector keeps matching.
    const oldMark = topbar.querySelector(".mockup-topbar__mark");
    if (oldMark && oldMark.tagName !== "A") {
      const anchor = document.createElement("a");
      anchor.className = oldMark.className;
      anchor.href = "./index.html";
      anchor.textContent = oldMark.textContent || "catalyst";
      anchor.setAttribute("aria-label", "Catalyst mockups gallery");
      oldMark.parentNode.replaceChild(anchor, oldMark);
    }

    // Breadcrumb → middle. If the meta tag is absent or empty, skip the crumb
    // and leave the original eyebrow alone (graceful fallback for pages that
    // forget to add the meta).
    const segments = parseBreadcrumb(readBreadcrumbMeta());
    if (segments.length > 0) {
      const eyebrow = topbar.querySelector(".eyebrow");
      const crumb = buildBreadcrumb(segments);
      const mark = topbar.querySelector(".mockup-topbar__mark");
      if (mark && mark.parentNode === topbar) {
        topbar.insertBefore(crumb, mark.nextSibling);
      } else {
        topbar.appendChild(crumb);
      }
      if (eyebrow && eyebrow.parentNode === topbar) {
        topbar.removeChild(eyebrow);
      }
    }

    // ⌘K chip → right.
    const chip = buildKeybindChip(palettePresenter);
    topbar.appendChild(chip);
  }

  // ----- Command palette (CTL-166) -----

  let paletteEl = null;
  let paletteState = {
    actions: [],
    visible: [],
    activeIndex: 0,
    query: "",
  };

  function buildPalette(executeAction) {
    const root = document.createElement("div");
    root.className = "mockup-palette";
    root.hidden = true;
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("aria-label", "Command palette");

    const backdrop = document.createElement("div");
    backdrop.className = "mockup-palette__backdrop";
    backdrop.setAttribute("aria-hidden", "true");
    backdrop.addEventListener("click", () => setPaletteOpen(false));

    const modal = document.createElement("div");
    modal.className = "mockup-palette__modal";

    const input = document.createElement("input");
    input.className = "mockup-palette__input";
    input.type = "search";
    input.placeholder = "Type to filter…";
    input.setAttribute("aria-label", "Filter palette actions");
    input.setAttribute("data-control", "palette-filter");

    const list = document.createElement("ul");
    list.className = "mockup-palette__list";
    list.setAttribute("role", "listbox");

    input.addEventListener("input", () => {
      paletteState.query = input.value || "";
      renderPaletteList(list, executeAction);
    });

    input.addEventListener("keydown", (ev) => {
      if (ev.key === "ArrowDown") {
        ev.preventDefault();
        movePaletteSelection(1, list);
      } else if (ev.key === "ArrowUp") {
        ev.preventDefault();
        movePaletteSelection(-1, list);
      } else if (ev.key === "Enter") {
        ev.preventDefault();
        const action = paletteState.visible[paletteState.activeIndex];
        if (action) executeAction(action);
      }
    });

    modal.appendChild(input);
    modal.appendChild(list);
    root.appendChild(backdrop);
    root.appendChild(modal);
    return root;
  }

  function renderPaletteList(list, executeAction) {
    while (list.firstChild) list.removeChild(list.firstChild);
    const filtered = filterPaletteActions(paletteState.actions, paletteState.query);
    paletteState.visible = filtered;
    paletteState.activeIndex = 0;

    if (filtered.length === 0) {
      const empty = document.createElement("li");
      empty.className = "mockup-palette__empty";
      empty.textContent = "No matches";
      list.appendChild(empty);
      return;
    }

    const groupedNoFilter = paletteState.query.trim().length === 0;
    let lastGroup = null;
    filtered.forEach((action, idx) => {
      if (groupedNoFilter && action.group !== lastGroup) {
        const label = document.createElement("li");
        label.className = "mockup-palette__group-label";
        label.textContent = action.group;
        label.setAttribute("aria-hidden", "true");
        list.appendChild(label);
        lastGroup = action.group;
      }

      const row = document.createElement("li");
      row.className = "mockup-palette__row";
      if (idx === paletteState.activeIndex) {
        row.classList.add("mockup-palette__row--active");
      }
      row.setAttribute("role", "option");
      row.setAttribute("data-action-id", action.id);

      const labelEl = document.createElement("span");
      labelEl.className = "mockup-palette__row-label";
      labelEl.textContent = action.label;
      row.appendChild(labelEl);

      if (Array.isArray(action.hint) && action.hint.length > 0) {
        const keys = document.createElement("span");
        keys.className = "mockup-palette__row-keys";
        action.hint.forEach((k) => {
          const kbd = document.createElement("kbd");
          kbd.className = "mockup-palette__row-kbd";
          kbd.textContent = k;
          keys.appendChild(kbd);
        });
        row.appendChild(keys);
      }

      row.addEventListener("click", () => executeAction(action));
      list.appendChild(row);
    });
  }

  function movePaletteSelection(delta, list) {
    if (paletteState.visible.length === 0) return;
    const next =
      (paletteState.activeIndex + delta + paletteState.visible.length) %
      paletteState.visible.length;
    paletteState.activeIndex = next;
    const rows = list.querySelectorAll(".mockup-palette__row");
    rows.forEach((row, idx) => {
      row.classList.toggle("mockup-palette__row--active", idx === next);
    });
    const activeRow = rows[next];
    if (activeRow && typeof activeRow.scrollIntoView === "function") {
      activeRow.scrollIntoView({ block: "nearest" });
    }
  }

  function ensurePalette(executeAction) {
    if (paletteEl && document.body.contains(paletteEl)) return paletteEl;
    paletteEl = buildPalette(executeAction);
    document.body.appendChild(paletteEl);
    return paletteEl;
  }

  function isPaletteOpen() {
    return Boolean(paletteEl && paletteEl.hidden === false);
  }

  function setPaletteOpen(open) {
    if (!paletteEl) return;
    paletteEl.hidden = !open;
    if (open) {
      const input = paletteEl.querySelector(".mockup-palette__input");
      const list = paletteEl.querySelector(".mockup-palette__list");
      if (input) {
        input.value = paletteState.query || "";
        if (typeof input.focus === "function") input.focus();
      }
      if (list) renderPaletteList(list, paletteState.executeAction);
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
        if (isPaletteOpen()) {
          setPaletteOpen(false);
          ev.preventDefault();
          return;
        }
        if (isCheatSheetOpen()) {
          setCheatSheetOpen(false);
          ev.preventDefault();
          return;
        }
        if (controller) controller.setPopoverOpen(false);
        clearGPrefix();
        return;
      }

      // ⌘K / Ctrl K — open command palette (CTL-166). Fires even when focus is
      // on an input so users can re-summon the palette while typing in the
      // page's own search fields. The palette modal owns Esc to close.
      if (
        (ev.metaKey || ev.ctrlKey) &&
        !ev.shiftKey &&
        !ev.altKey &&
        typeof ev.key === "string" &&
        ev.key.toLowerCase() === "k"
      ) {
        ev.preventDefault();
        setPaletteOpen(!isPaletteOpen());
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

    // Build the palette eagerly so the ⌘K keybinding can open it immediately
    // — but keep it hidden until the user triggers it. The first call to
    // `ensurePalette` wires the executor; subsequent calls are no-ops.
    const cycleSystem = () => {
      if (!controller) return;
      controller.handleSystemChange(nextSystem(controller.state.system));
    };
    const toggleTheme = () => {
      const current =
        document.documentElement.getAttribute("data-theme") || DEFAULTS.theme;
      const nxt = nextTheme(current);
      if (controller) controller.state.theme = nxt;
      document.documentElement.setAttribute("data-theme", nxt);
      const next = controller ? controller.state : { system: DEFAULTS.system, theme: nxt };
      persist(next);
    };
    const cyclePalette = () => {
      // Reserved — palettes.css does not exist yet. Intentional no-op so the
      // palette can still surface the action and stay in sync with the
      // keybinding row in the cheatsheet.
    };

    const executeAction = (action) => {
      if (!action || typeof action !== "object") return;
      setPaletteOpen(false);
      if (action.type === "nav" && action.payload && action.payload.path) {
        window.location.href = "./" + action.payload.path;
        return;
      }
      if (action.type === "appearance" && action.payload) {
        if (action.payload.action === "toggleTheme") toggleTheme();
        else if (action.payload.action === "cycleSystem") cycleSystem();
        else if (action.payload.action === "cyclePalette") cyclePalette();
        return;
      }
      if (action.type === "help" && action.payload && action.payload.action === "openCheatsheet") {
        setCheatSheetOpen(true);
      }
    };

    paletteState.actions = paletteActions(GNAV);
    paletteState.executeAction = executeAction;
    ensurePalette(executeAction);

    enhanceTopbar({ toggle: () => setPaletteOpen(!isPaletteOpen()) });

    installKeybindings(controller);
  };

  if (document.readyState !== "loading") {
    boot();
  } else {
    document.addEventListener("DOMContentLoaded", boot);
  }
})();
