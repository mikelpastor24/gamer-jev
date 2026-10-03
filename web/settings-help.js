/** Keep contextual help inside the modal so it is available to all input methods. */
export function createSettingsHelp() {
  const dialog = document.querySelector("#settings-dialog");
  let active = null;
  let pinned = false;
  let closeTimer;

  function hide() {
    clearTimeout(closeTimer);
    if (active) active.tooltip.hidden = true;
    active = null;
    pinned = false;
  }

  function position() {
    if (!active) return;
    const { button, tooltip } = active;
    const anchor = button.getBoundingClientRect();
    const bounds = tooltip.getBoundingClientRect();
    const margin = 12;
    const below = anchor.bottom + 6;
    const top = below + bounds.height <= window.innerHeight - margin ? below : anchor.top - bounds.height - 6;
    tooltip.style.left = `${Math.max(margin, Math.min(anchor.left, window.innerWidth - bounds.width - margin))}px`;
    tooltip.style.top = `${Math.max(margin, Math.min(top, window.innerHeight - bounds.height - margin))}px`;
  }

  function show(item) {
    clearTimeout(closeTimer);
    if (active !== item) {
      hide();
      active = item;
      item.tooltip.hidden = false;
    }
    position();
  }

  function scheduleHide(item) {
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => {
      if (active === item && !pinned && document.activeElement !== item.button &&
          !item.button.matches(":hover") && !item.tooltip.matches(":hover")) hide();
    }, 120);
  }

  dialog.querySelectorAll("[data-help]").forEach((element, index) => {
    const name = element.dataset.helpName ?? element.textContent.trim();
    const control = element instanceof HTMLLabelElement ? element.control : element;
    const tooltip = document.createElement("div");
    tooltip.id = `settings-help-${index}`;
    tooltip.className = "settings-tooltip";
    tooltip.setAttribute("role", "tooltip");
    tooltip.textContent = element.dataset.help;
    tooltip.hidden = true;
    dialog.append(tooltip);

    const button = document.createElement("button");
    button.type = "button";
    button.className = "settings-help";
    button.setAttribute("aria-label", `Help for ${name}`);
    button.setAttribute("aria-describedby", tooltip.id);
    button.innerHTML = '<span aria-hidden="true">?</span>';
    element.after(button);
    if (control) {
      const descriptions = [control.getAttribute("aria-describedby"), tooltip.id].filter(Boolean);
      control.setAttribute("aria-describedby", descriptions.join(" "));
    }

    const item = { button, tooltip };
    button.addEventListener("pointerenter", (event) => { if (event.pointerType !== "touch") show(item); });
    button.addEventListener("pointerleave", () => scheduleHide(item));
    button.addEventListener("focus", () => show(item));
    button.addEventListener("blur", () => { if (active === item) hide(); });
    button.addEventListener("click", () => {
      if (active === item && pinned) hide();
      else { show(item); pinned = true; }
    });
    tooltip.addEventListener("pointerenter", () => clearTimeout(closeTimer));
    tooltip.addEventListener("pointerleave", () => scheduleHide(item));
  });

  dialog.addEventListener("pointerdown", (event) => {
    if (active && !active.button.contains(event.target)) hide();
  });
  dialog.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && active) {
      event.preventDefault();
      event.stopPropagation();
      hide();
    }
  }, true);
  dialog.addEventListener("close", hide);
  dialog.addEventListener("settings-tab-change", hide);
  dialog.addEventListener("change", hide);
  dialog.addEventListener("submit", hide, true);
  dialog.addEventListener("scroll", position, true);
  window.addEventListener("resize", position);
}
