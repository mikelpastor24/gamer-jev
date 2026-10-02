const query = (selector) => document.querySelector(selector);
const limits = [
  ["maxDecisions", "#agent-limit-decisions", 100, 10_000],
  ["maxRequests", "#agent-limit-requests", 300, 10_000],
  ["maxSeconds", "#agent-limit-seconds", 300, 86_400],
];

/** Keep drafts in memory only; polling never overwrites an edit. */
export function createAgentSettingsEditor({ request, onApply, message }) {
  let revision = null;
  let dirty = false;
  let loading = false;
  let boundedValues = [];
  const form = query("#agent-settings-form");
  const fields = query("#agent-settings-fields");
  const apply = query("#apply-agent-settings");
  const reload = query("#reload-agent-settings");
  const unlimited = query("#agent-unlimited");

  function setSection(name) {
    query("#agent-settings-section").value = name;
    query("#agent-objectives").hidden = name !== "objectives";
    query("#agent-limits").hidden = name !== "limits";
  }
  query("#agent-settings-section").addEventListener("change", (event) => setSection(event.target.value));

  function updateLimitInputs() {
    for (const [, selector] of limits) query(selector).disabled = unlimited.checked;
  }
  unlimited.addEventListener("change", () => {
    if (unlimited.checked) {
      boundedValues = limits.map(([, selector, fallback]) => query(selector).value || String(fallback));
      for (const [, selector] of limits) query(selector).value = "";
    } else limits.forEach(([, selector, fallback], index) => { query(selector).value = boundedValues[index] ?? String(fallback); });
    updateLimitInputs();
  });
  form.addEventListener("input", () => { dirty = true; });

  async function load() {
    if (loading) return;
    loading = true; fields.disabled = true; apply.disabled = true; reload.disabled = true;
    try {
      const result = await request("/api/agent-settings");
      const settings = result.settings;
      revision = result.revision;
      query("#agent-goal-input").value = settings.objectives.goal;
      query("#agent-constraints-input").value = settings.objectives.constraints.join("\n");
      query("#agent-milestones-input").value = settings.objectives.milestones.join("\n");
      for (const [name, selector] of limits) query(selector).value = settings[name] ?? "";
      boundedValues = limits.map(([name, , fallback]) => String(settings[name] ?? fallback));
      unlimited.checked = limits.every(([name]) => settings[name] === null);
      query("#agent-action-frames").value = settings.actionFrames;
      updateLimitInputs(); dirty = false;
    } catch (error) { message(error.message, true); }
    finally { loading = false; fields.disabled = revision === null; apply.disabled = revision === null; reload.disabled = false; }
  }
  reload.addEventListener("click", () => { void load(); });
  query("#settings-dialog").addEventListener("settings-tab-change", (event) => { if (event.detail === "agent" && !dirty) void load(); });
  query("#open-settings").addEventListener("click", () => {
    if (!query("#settings-agent").hidden && !dirty) void load();
  });

  function invalid(selector, section, text) {
    setSection(section); query(selector).focus(); throw new Error(text);
  }
  function list(selector, name) {
    const entries = query(selector).value.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
    if (entries.length > 16 || entries.some((entry) => entry.length > 500)) invalid(selector, "objectives", `${name}: use at most 16 lines, each at most 500 characters.`);
    return entries;
  }
  function number(selector, maximum, nullable = true) {
    const input = query(selector);
    if (nullable && unlimited.checked) return null;
    if (!input.validity.badInput && !input.value.trim() && nullable) return null;
    const value = Number(input.value);
    if (input.validity.badInput || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
      invalid(selector, "limits", `${input.previousSibling?.textContent?.trim() || "Value"} must be an integer between 1 and ${maximum}.`);
    }
    return value;
  }
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (loading || revision === null) return;
    try {
      const goal = query("#agent-goal-input").value.trim();
      if (!goal || goal.length > 2000) invalid("#agent-goal-input", "objectives", "Enter an objective of at most 2,000 characters.");
      const settings = { objectives: { goal, constraints: list("#agent-constraints-input", "Constraints"), milestones: list("#agent-milestones-input", "Milestones") },
        actionFrames: number("#agent-action-frames", 600, false),
        ...Object.fromEntries(limits.map(([name, selector, , maximum]) => [name, number(selector, maximum)])) };
      apply.disabled = true; reload.disabled = true; fields.disabled = true; loading = true;
      const status = await request("/api/agent-settings", { revision, settings });
      onApply(status); revision = status.agent.settingsRevision; dirty = false;
      message(status.agent.state === "stopped" ? "Settings applied. Increase or disable the reached limit to continue." : "Agent settings applied. Session paused; resume when ready.");
    } catch (error) { message(error.message, true); }
    finally { loading = false; fields.disabled = revision === null; apply.disabled = revision === null; reload.disabled = false; }
  });
}
