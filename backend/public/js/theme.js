(function () {
  "use strict";

  const STORAGE_KEY = "status-page-theme";
  const root = document.documentElement;
  const isTheme = (value) => value === "light" || value === "dark";
  let currentTheme = null;

  function readStoredTheme() {
    try {
      const value = window.localStorage.getItem(STORAGE_KEY);
      return isTheme(value) ? value : null;
    } catch (_) {
      return null;
    }
  }

  function writeStoredTheme(theme) {
    try {
      window.localStorage.setItem(STORAGE_KEY, theme);
    } catch (_) {
      // Storage can be unavailable in private or hardened browser contexts.
    }
  }

  function preferredTheme() {
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }

  function syncControls(theme) {
    const nextTheme = theme === "dark" ? "light" : "dark";

    document.querySelectorAll("[data-enterprise-theme-toggle]").forEach((control) => {
      control.dataset.themeState = theme;
      control.setAttribute("aria-pressed", String(theme === "dark"));
      control.setAttribute("aria-label", `Switch to ${nextTheme} mode`);
      control.setAttribute("title", `Switch to ${nextTheme} mode`);

      const label = control.querySelector("[data-enterprise-theme-label]");
      if (label) label.textContent = `${nextTheme[0].toUpperCase()}${nextTheme.slice(1)} mode`;

      control.querySelectorAll("[data-theme-icon]").forEach((icon) => {
        icon.hidden = icon.dataset.themeIcon !== theme;
      });
    });
  }

  function announceTheme(theme) {
    window.dispatchEvent(new CustomEvent("enterprise:themechange", {
      detail: { theme }
    }));
  }

  function applyTheme(theme, options) {
    const settings = Object.assign({ persist: true, emit: true }, options);
    if (!isTheme(theme)) return currentTheme;

    const changed = currentTheme !== theme || root.dataset.theme !== theme;
    currentTheme = theme;
    root.dataset.theme = theme;
    if (settings.persist) writeStoredTheme(theme);
    syncControls(theme);
    if (settings.emit && changed) announceTheme(theme);
    return theme;
  }

  function toggleTheme() {
    const activeTheme = isTheme(root.dataset.theme) ? root.dataset.theme : currentTheme;
    return applyTheme(activeTheme === "dark" ? "light" : "dark");
  }

  const initialTheme = readStoredTheme()
    || (isTheme(root.dataset.theme) ? root.dataset.theme : null)
    || preferredTheme();
  applyTheme(initialTheme, { persist: false, emit: false });

  document.addEventListener("click", (event) => {
    const control = event.target.closest("[data-enterprise-theme-toggle]");
    if (!control || control.disabled || control.getAttribute("aria-disabled") === "true") return;
    event.preventDefault();
    toggleTheme();
  });

  window.addEventListener("storage", (event) => {
    if (event.key === STORAGE_KEY && isTheme(event.newValue)) {
      applyTheme(event.newValue, { persist: false });
    }
  });

  // Keep shared controls accurate when a legacy page changes data-theme itself.
  new MutationObserver(() => {
    const theme = root.dataset.theme;
    if (!isTheme(theme) || theme === currentTheme) return;
    currentTheme = theme;
    syncControls(theme);
    announceTheme(theme);
  }).observe(root, { attributes: true, attributeFilter: ["data-theme"] });

  window.EnterpriseTheme = Object.freeze({
    key: STORAGE_KEY,
    get: () => (isTheme(root.dataset.theme) ? root.dataset.theme : currentTheme),
    set: (theme) => applyTheme(theme),
    toggle: toggleTheme,
    sync: () => syncControls(isTheme(root.dataset.theme) ? root.dataset.theme : currentTheme)
  });
})();
