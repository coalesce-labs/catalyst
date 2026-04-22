/*
 * Mockup harness chrome — floating switcher that toggles html[data-system].
 *
 * Preference priority: window.__catalystMockupPrefs (set by pre-paint bootstrap)
 *   > URL query string > localStorage > default.
 *
 * URL "clean" rule: the default value is never written as a query param —
 * only non-default values appear in the URL.
 *
 * Idempotent: mount() early-returns if a .mockup-chrome element already exists.
 */
(function () {
  const LS_KEY = "catalyst.mockup.prefs";
  const DEFAULTS = { system: "operator-console" };
  const SYSTEMS = ["operator-console", "precision-instrument"];
  const SYSTEM_LABELS = {
    "operator-console": "Operator Console",
    "precision-instrument": "Precision Instrument",
  };

  function readPrefs() {
    if (window.__catalystMockupPrefs) {
      return { ...window.__catalystMockupPrefs };
    }
    const url = new URLSearchParams(window.location.search);
    let stored = {};
    try {
      stored = JSON.parse(window.localStorage.getItem(LS_KEY) || "{}");
    } catch (_e) {
      stored = {};
    }
    const candidate = url.get("system") || stored.system || DEFAULTS.system;
    const system = SYSTEMS.includes(candidate) ? candidate : DEFAULTS.system;
    return { system };
  }

  function apply(prefs) {
    document.documentElement.setAttribute("data-system", prefs.system);
  }

  function persist(prefs) {
    try {
      window.localStorage.setItem(LS_KEY, JSON.stringify(prefs));
    } catch (_e) {
      /* localStorage unavailable — URL still round-trips */
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

  function mount(prefs) {
    if (document.querySelector(".mockup-chrome")) return;

    const state = { ...prefs };
    const root = document.createElement("div");
    root.className = "mockup-chrome";

    const pill = buildPill(state);
    const valueEl = pill.querySelector(".mockup-chrome__pill-value");

    const handleChange = (system) => {
      if (!SYSTEMS.includes(system)) return;
      state.system = system;
      apply(state);
      persist(state);
      valueEl.textContent = SYSTEM_LABELS[system];
      root
        .querySelectorAll(".mockup-chrome__option")
        .forEach((el) => el.classList.remove("mockup-chrome__option--checked"));
      const checkedInput = root.querySelector(`.mockup-chrome__option input[value="${system}"]`);
      if (checkedInput && checkedInput.parentElement) {
        checkedInput.parentElement.classList.add("mockup-chrome__option--checked");
      }
    };

    const popover = buildPopover(state, handleChange);

    const setOpen = (open) => {
      popover.hidden = !open;
      pill.setAttribute("aria-expanded", open ? "true" : "false");
    };

    pill.addEventListener("click", () => {
      setOpen(popover.hidden);
    });

    document.addEventListener("click", (ev) => {
      if (!root.contains(ev.target)) setOpen(false);
    });

    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") setOpen(false);
    });

    root.appendChild(pill);
    root.appendChild(popover);
    document.body.appendChild(root);
  }

  const prefs = readPrefs();
  apply(prefs);
  persist(prefs);

  if (document.readyState !== "loading") {
    mount(prefs);
  } else {
    document.addEventListener("DOMContentLoaded", () => mount(prefs));
  }
})();
