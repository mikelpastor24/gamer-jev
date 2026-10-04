const query = (selector) => document.querySelector(selector);
const providerControl = (kind) => query(kind === "vision" ? "#vision-provider-select" : "#decision-provider");
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
  let gameId = 0;
  let generation = 0;
  let boundedValues = [];
  let playerEnabled = false;
  let providers;
  let activeProviders = {};
  let modelDrafts = {};
  let defaultObjectives = null;
  const form = query("#agent-settings-form");
  const fields = query("#agent-settings-fields");
  const apply = query("#apply-agent-settings");
  const reload = query("#reload-agent-settings");
  const unlimited = query("#agent-unlimited");
  const useDefaults = query("#use-game-objectives");

  function fillObjectives(objectives) {
    query("#agent-goal-input").value = objectives.goal;
    query("#agent-constraints-input").value = objectives.constraints.join("\n");
    query("#agent-milestones-input").value = objectives.milestones.join("\n");
    updateObjectiveSource();
  }
  function updateObjectiveSource() {
    const lines = (selector) => query(selector).value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const suggested = defaultObjectives && query("#agent-goal-input").value.trim() === defaultObjectives.goal &&
      JSON.stringify(lines("#agent-constraints-input")) === JSON.stringify(defaultObjectives.constraints) &&
      JSON.stringify(lines("#agent-milestones-input")) === JSON.stringify(defaultObjectives.milestones);
    query("#game-objectives-source").textContent = !defaultObjectives ? "Set objectives for this game." : suggested ?
      "Game reader suggestions. Edit any field to customize them." : "Custom objectives. Game reader suggestions are available.";
  }
  useDefaults.addEventListener("click", () => {
    if (loading || !defaultObjectives || revision === null) return;
    fillObjectives(defaultObjectives); dirty = true;
    message("Game objectives copied to the draft. Apply changes to use them.");
  });

  function setSection(name) {
    query("#agent-settings-section").value = name;
    query("#agent-models").hidden = name !== "models";
    query("#agent-objectives").hidden = name !== "objectives";
    query("#agent-limits").hidden = name !== "limits";
  }
  query("#agent-settings-section").addEventListener("change", (event) => setSection(event.target.value));

  function updateModels() {
    for (const kind of ["decision", "vision"]) {
      const provider = providerControl(kind).value;
      const input = query(`#${kind}-model`);
      input.disabled = provider === "mock" || provider === "none";
    }
    const manual = query("#player-mode").value === "manual";
    const missing = providers.decisions.filter((provider) => !provider.available).map((provider) => provider.credential);
    query("#provider-availability").textContent = manual ? "Manual play makes no model requests. Set an objective before enabling the agent." :
      missing.length ? `Keys stay on the server. Missing: ${[...new Set(missing)].join(", ")}. Edit .env and restart to enable these providers.` :
      "Configured keys stay on the server. Account access and model support are checked when a request is made.";
  }
  query("#player-mode").addEventListener("change", updateModels);
  for (const kind of ["decision", "vision"]) providerControl(kind).addEventListener("change", () => {
    if (!providers) return;
    const input = query(`#${kind}-model`);
    modelDrafts[`${kind}:${activeProviders[kind]}`] = input.value;
    activeProviders[kind] = providerControl(kind).value;
    input.value = modelDrafts[`${kind}:${activeProviders[kind]}`] ?? "";
    updateModels();
  });

  function fillModels(result) {
    providers = result.providers; modelDrafts = {};
    for (const [kind, choices] of [["decision", providers.decisions], ["vision", providers.vision]]) {
      const select = providerControl(kind);
      select.replaceChildren();
      for (const provider of choices) {
        const option = document.createElement("option");
        option.value = provider.id;
        option.textContent = `${provider.name}${provider.available ? "" : " (key missing)"}`;
        option.disabled = !provider.available;
        select.append(option);
        modelDrafts[`${kind}:${provider.id}`] = provider.model;
      }
      const selected = result.selection[kind === "decision" ? "decisionProvider" : "visionProvider"];
      select.value = selected; activeProviders[kind] = selected;
      query(`#${kind}-model`).value = result.selection[kind === "decision" ? "decisionModel" : "visionModel"];
    }
    query("#player-mode").value = result.selection.mode;
    updateModels();
  }

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
  form.addEventListener("input", () => { dirty = true; updateObjectiveSource(); });

  async function load() {
    if (loading) return;
    const current = generation;
    loading = true; fields.disabled = true; apply.disabled = true; reload.disabled = true;
    try {
      const player = await request("/api/player-settings");
      const result = player.enabled ? player : await request("/api/agent-settings");
      if (current !== generation) return;
      playerEnabled = Boolean(player.enabled);
      query('#agent-settings-section option[value="models"]').hidden = !playerEnabled;
      if (playerEnabled) fillModels(result);
      else if (query("#agent-settings-section").value === "models") setSection("objectives");
      gameId = result.gameId ?? 0;
      const settings = result.settings ?? { ...result.defaults, objectives: { goal: "", constraints: [], milestones: [] } };
      revision = result.revision;
      defaultObjectives = result.defaultObjectives ?? null;
      useDefaults.hidden = !defaultObjectives;
      fillObjectives(settings.objectives);
      for (const [name, selector] of limits) query(selector).value = settings[name] ?? "";
      boundedValues = limits.map(([name, , fallback]) => String(settings[name] ?? fallback));
      unlimited.checked = limits.every(([name]) => settings[name] === null);
      query("#agent-action-frames").value = settings.actionFrames;
      updateLimitInputs(); dirty = false;
    } catch (error) { if (current === generation) message(error.message, true); }
    finally { if (current === generation) { loading = false; fields.disabled = revision === null; apply.disabled = revision === null; reload.disabled = false; } }
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
      invalid(selector, "limits", `${input.labels[0]?.textContent.trim() || "Value"} must be an integer between 1 and ${maximum}.`);
    }
    return value;
  }
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (loading || revision === null) return;
    const current = generation;
    try {
      const goal = query("#agent-goal-input").value.trim();
      const selection = playerEnabled ? { mode: query("#player-mode").value, decisionProvider: query("#decision-provider").value,
        visionProvider: query("#vision-provider-select").value, decisionModel: query("#decision-model").value.trim(), visionModel: query("#vision-model").value.trim() } : null;
      if ((!goal && selection?.mode !== "manual") || goal.length > 2000) invalid("#agent-goal-input", "objectives", "Enter an objective of at most 2,000 characters before enabling the agent.");
      const settings = { objectives: { goal, constraints: list("#agent-constraints-input", "Constraints"), milestones: list("#agent-milestones-input", "Milestones") },
        actionFrames: number("#agent-action-frames", 600, false),
        ...Object.fromEntries(limits.map(([name, selector, , maximum]) => [name, number(selector, maximum)])) };
      apply.disabled = true; reload.disabled = true; fields.disabled = true; loading = true;
      const status = await request(playerEnabled ? "/api/player-settings" : "/api/agent-settings", { revision, settings, gameId, ...(selection ? { selection } : {}) });
      if (current !== generation) return;
      onApply(status);
      if (current === generation) { revision = playerEnabled ? status.playerRevision : status.agent.settingsRevision; dirty = false; }
      message(status.agent?.state === "stopped" ? "Settings applied. Increase or disable the reached limit to continue." : "Settings applied. Game paused; resume when ready.");
    } catch (error) { if (current === generation) message(error.message, true); }
    finally { if (current === generation) { loading = false; fields.disabled = revision === null; apply.disabled = revision === null; reload.disabled = false; } }
  });
  return { reset() {
    generation++; revision = null; gameId = 0; dirty = false; loading = false; defaultObjectives = null; useDefaults.hidden = true;
    fields.disabled = true; apply.disabled = true; reload.disabled = false; form.reset(); setSection("models");
    if (!query("#settings-agent").hidden) void load();
  } };
}
