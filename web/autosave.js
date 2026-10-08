const query = (selector) => document.querySelector(selector);

/** Keep interval drafts local until Apply; polling only updates the saved status. */
export function createAutosaveSettingsEditor({ request, onApply, message }) {
  const form = query("#autosave-settings-form");
  const fields = query("#autosave-settings-fields");
  const enabled = query("#autosave-enabled");
  const decisions = query("#autosave-decisions");
  const seconds = query("#autosave-seconds");
  const summary = query("#autosave-status");
  let revision = null;
  let gameId;
  let generation = 0;
  let dirty = false;
  let pending = false;
  let lastError = null;

  function updateInputs() {
    query("#autosave-intervals").hidden = !enabled.checked;
    decisions.disabled = !enabled.checked; seconds.disabled = !enabled.checked;
  }
  form.addEventListener("input", () => { dirty = true; updateInputs(); });

  function setStatus(status) {
    if (gameId !== status.gameId) {
      gameId = status.gameId; generation++; dirty = false; pending = false; revision = null; lastError = null;
    }
    const autosave = status.autosave;
    if (!autosave) { fields.disabled = true; return; }
    if (!dirty && !pending) {
      revision = autosave.revision;
      enabled.checked = autosave.settings.enabled;
      decisions.value = String(autosave.settings.decisionInterval); seconds.value = String(autosave.settings.manualSeconds);
      updateInputs();
    }
    fields.disabled = pending || revision === null || status.loadingRom;
    const lastSave = autosave.lastSavedAt ? ` Last save: ${new Date(autosave.lastSavedAt).toLocaleTimeString("en-US")}.` : "";
    summary.textContent = autosave.error ? `Autosave failed: ${autosave.error}` : autosave.saving ? "Saving checkpoint…" :
      !autosave.settings.enabled ? `Autosave is off.${lastSave}` :
        status.agent ? `Every ${autosave.settings.decisionInterval} Jev decisions.${lastSave}` :
          `Every ${autosave.settings.manualSeconds} seconds of manual play.${lastSave}`;
    summary.classList.toggle("error", Boolean(autosave.error));
    if (autosave.error && autosave.error !== lastError) message(`Autosave failed: ${autosave.error}`, true);
    lastError = autosave.error;
  }

  function integer(input, maximum) {
    const value = Number(input.value);
    if (input.validity.badInput || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
      input.focus(); throw new Error(`Autosave intervals must be integers between 1 and ${maximum}.`);
    }
    return value;
  }
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (pending || revision === null) return;
    const current = generation;
    try {
      const settings = { enabled: enabled.checked, decisionInterval: integer(decisions, 10_000), manualSeconds: integer(seconds, 86_400) };
      pending = true; fields.disabled = true;
      const status = await request("/api/autosave-settings", { settings, revision, gameId });
      if (current !== generation) return;
      pending = false; dirty = false; onApply(status);
      message(settings.enabled ? "Autosave enabled. The game continues with the new intervals." : "Autosave disabled.");
    } catch (error) {
      if (current === generation) {
        if (pending) { revision = null; dirty = false; }
        message(error.message, true);
      }
    } finally { if (current === generation) { pending = false; fields.disabled = revision === null; } }
  });
  return { setStatus };
}
