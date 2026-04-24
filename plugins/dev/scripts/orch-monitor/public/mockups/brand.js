// Brand showcase live data — extracted from brand.html (CTL-178)
// Populates color swatches, type-role metadata, and duration readouts
// from computed styles on html:root, then refreshes when data-theme or
// data-system attrs change.

(function () {
  // Color tokens, grouped. Each entry: { name, var, group, kind? }.
  // kind="border" renders as an inset ring instead of a filled swatch.
  const COLOR_TOKENS = [
    { name: "bg", var: "--color-bg", group: "Canvas" },
    { name: "surface-1", var: "--color-surface-1", group: "Canvas" },
    { name: "surface-2", var: "--color-surface-2", group: "Canvas" },
    { name: "surface-3", var: "--color-surface-3", group: "Canvas" },
    { name: "border-subtle", var: "--color-border-subtle", group: "Borders", kind: "border" },
    { name: "border-default", var: "--color-border-default", group: "Borders", kind: "border" },
    { name: "border-strong", var: "--color-border-strong", group: "Borders", kind: "border" },
    { name: "text-hi", var: "--color-text-hi", group: "Text" },
    { name: "text-md", var: "--color-text-md", group: "Text" },
    { name: "text-lo", var: "--color-text-lo", group: "Text" },
    { name: "text-disabled", var: "--color-text-disabled", group: "Text" },
    { name: "accent", var: "--color-accent", group: "Accent" },
    { name: "accent-hover", var: "--color-accent-hover", group: "Accent" },
    { name: "accent-active", var: "--color-accent-active", group: "Accent" },
    { name: "success", var: "--color-success", group: "State" },
    { name: "warning", var: "--color-warning", group: "State" },
    { name: "danger", var: "--color-danger", group: "State" },
    { name: "info", var: "--color-info", group: "State" },
  ];

  // Type roles — the element in the DOM that represents each role.
  const TYPE_ROLES = [
    { role: "display", selector: ".type-sample--display" },
    { role: "title", selector: ".type-sample--title" },
    { role: "heading", selector: ".type-sample--heading" },
    { role: "body", selector: ".type-sample--body" },
    { role: "label", selector: ".type-sample--label" },
    { role: "data", selector: ".type-sample--data" },
  ];

  function buildSwatches() {
    const containers = document.querySelectorAll("[data-color-group]");
    containers.forEach((container) => {
      const group = container.getAttribute("data-color-group");
      const grid = container.querySelector("[data-swatches]");
      if (!grid) return;
      const tokens = COLOR_TOKENS.filter((t) => t.group === group);
      grid.innerHTML = "";
      tokens.forEach((token) => {
        const article = document.createElement("article");
        article.className = "swatch";
        article.setAttribute("data-token", token.name);
        article.setAttribute("data-var", token.var);
        const chip = document.createElement("div");
        chip.className = "swatch__chip";
        if (token.kind === "border") {
          chip.classList.add("swatch__chip--border");
          chip.style.color = `var(${token.var})`;
        } else {
          chip.style.background = `var(${token.var})`;
          chip.style.borderColor = "var(--color-border-subtle)";
          chip.style.borderStyle = "solid";
          chip.style.borderWidth = "1px";
        }
        article.appendChild(chip);
        const info = document.createElement("div");
        info.className = "swatch__info";
        const name = document.createElement("span");
        name.className = "swatch__name";
        name.textContent = token.name;
        const v = document.createElement("span");
        v.className = "swatch__var";
        v.textContent = token.var;
        const hex = document.createElement("span");
        hex.className = "swatch__hex";
        hex.setAttribute("data-hex", "");
        hex.textContent = "—";
        info.appendChild(name);
        info.appendChild(v);
        info.appendChild(hex);
        article.appendChild(info);
        grid.appendChild(article);
      });
    });
  }

  function refreshSwatches() {
    const cs = getComputedStyle(document.documentElement);
    document.querySelectorAll(".swatch").forEach((sw) => {
      const v = sw.getAttribute("data-var");
      if (!v) return;
      const value = cs.getPropertyValue(v).trim().toUpperCase();
      const hex = sw.querySelector("[data-hex]");
      if (hex) hex.textContent = value || "—";
    });
  }

  function refreshTypeMeta() {
    TYPE_ROLES.forEach(({ role, selector }) => {
      const el = document.querySelector(selector);
      const target = document.querySelector(`[data-type-meta="${role}"]`);
      if (!el || !target) return;
      const cs = getComputedStyle(el);
      const family = cs.fontFamily.split(",")[0].trim().replace(/^["']|["']$/g, "");
      const size = cs.fontSize;
      const lh = cs.lineHeight;
      const weight = cs.fontWeight;
      const tracking = cs.letterSpacing === "normal" ? "0" : cs.letterSpacing;
      target.textContent = `${family} · ${size} / ${lh} · ${weight} · ${tracking}`;
    });
  }

  function refreshDurations() {
    const cs = getComputedStyle(document.documentElement);
    document.querySelectorAll("[data-duration]").forEach((el) => {
      const v = el.getAttribute("data-duration");
      if (!v) return;
      const value = cs.getPropertyValue(v).trim();
      el.textContent = value || "—";
    });
  }

  function refreshLive() {
    refreshSwatches();
    refreshTypeMeta();
    refreshDurations();
  }

  function init() {
    buildSwatches();
    refreshLive();
    new MutationObserver(refreshLive).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-system"],
    });
  }

  if (document.readyState !== "loading") {
    init();
  } else {
    document.addEventListener("DOMContentLoaded", init);
  }
})();
