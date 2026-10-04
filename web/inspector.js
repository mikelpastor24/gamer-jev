const STORAGE_KEY = "gamer-jev.viewer.v1";
const panelNames = ["agent", "state", "observation", "actions"];
const defaults = () => ({ panels: Object.fromEntries(panelNames.map((name) => [name, true])), controller: null, hiddenFields: {} });
const query = (selector) => document.querySelector(selector);
const label = (name) => name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replaceAll("_", " ");

function readPreferences() {
  const result = defaults();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw || raw.length > 16384) return result;
    const saved = JSON.parse(raw);
    for (const name of panelNames) if (typeof saved.panels?.[name] === "boolean") result.panels[name] = saved.panels[name];
    if (typeof saved.controller === "boolean") result.controller = saved.controller;
    for (const [reader, fields] of Object.entries(saved.hiddenFields ?? {}).slice(0, 32)) {
      if (/^[a-z][a-z0-9-]{0,63}$/.test(reader) && Array.isArray(fields)) result.hiddenFields[reader] = fields.filter((field) =>
        typeof field === "string" && /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(field)).slice(0, 64);
    }
  } catch { /* Storage can be unavailable; the dashboard still works. */ }
  return result;
}

/** UI preferences contain visibility only, never game state, observations, or credentials. */
export function createInspector(onControllerVisibility) {
  let preferences = readPreferences();
  let hasAgent = false;
  let playerConfigurable = false;
  let focused = false;
  let expanded = null;
  let mobileTab = "game";
  let editingFields = false;
  let snapshot;
  let exchange = null;
  let exchangeSnapshot = null;
  let exchangeRevision = -1;
  let wantedExchangeRevision = 0;
  let exchangeTab = "input";
  const exchangeSections = { input: "summary", response: "summary" };
  let selectedAction;
  let detailText = "";
  let observationCache = "";
  let observationPages = [];
  let detailPages = [];
  const page = { state: 0, actions: 0, observation: 0, detail: 0 };
  let stateSignature = "";
  let actionSignature = "";
  const workspace = query("#workspace");
  const inspector = query("#inspector");
  const dialog = query("#detail-dialog");
  const settings = query("#settings-dialog");

  function savePreferences() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences)); }
    catch { /* Visibility remains available for this visit. */ }
  }

  function available(name) { return (hasAgent || name !== "agent" && name !== "observation") && preferences.panels[name]; }

  function applyLayout() {
    if (expanded && !available(expanded)) expanded = null;
    if (mobileTab !== "game" && !available(mobileTab)) mobileTab = "game";
    if (focused) mobileTab = "game";
    const visible = [];
    for (const name of panelNames) {
      const panel = query(`[data-panel="${name}"]`);
      panel.hidden = focused || !available(name) || expanded !== null && expanded !== name;
      panel.classList.toggle("mobile-active", mobileTab === name);
      panel.classList.remove("first-panel");
      if (!panel.hidden) visible.push(panel);
      query(`[data-visibility="${name}"]`).checked = preferences.panels[name];
      query(`[data-expand="${name}"]`).setAttribute("aria-pressed", String(expanded === name));
      query(`[data-expand="${name}"]`).setAttribute("aria-label", `${expanded === name ? "Restore" : "Expand"} ${panel.querySelector("h2").firstChild.textContent.trim()}`);
      query(`[data-tab="${name}"]`).hidden = !available(name) || focused;
    }
    visible[0]?.classList.add("first-panel");
    inspector.dataset.count = String(visible.length);
    inspector.hidden = visible.length === 0;
    workspace.classList.toggle("game-focused", inspector.hidden);
    workspace.dataset.mobileActive = mobileTab;
    document.querySelectorAll("[data-tab]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.tab === mobileTab)));
    document.querySelectorAll("[data-agent-only]").forEach((element) => { element.hidden = !hasAgent; });
    query("#agent-tab").hidden = !hasAgent && !playerConfigurable;
    query("#focus-game").checked = inspector.hidden;
    const showController = preferences.controller ?? !hasAgent;
    query("#show-controller").checked = showController;
    query("#controller").hidden = !showController;
    onControllerVisibility(showController);
    requestAnimationFrame(render);
  }

  function pagination(name, total, size) {
    const pages = Math.max(1, Math.ceil(total / size));
    page[name] = Math.min(page[name], pages - 1);
    query(`#${name}-previous`).disabled = page[name] === 0;
    query(`#${name}-next`).disabled = page[name] === pages - 1;
    query(`#${name}-page`).textContent = `Page ${page[name] + 1} of ${pages}`;
    return page[name] * size;
  }

  function capacity(element, rowHeight) {
    const columns = getComputedStyle(element).gridTemplateColumns.split(" ").length;
    const gap = parseFloat(getComputedStyle(element).rowGap) || 0;
    return Math.max(1, Math.floor((element.clientHeight + gap) / (rowHeight + gap))) * columns;
  }

  function empty(element, text) {
    const message = document.createElement("p"); message.className = "empty-state"; message.textContent = text;
    element.replaceChildren(message);
  }

  function renderState() {
    const container = query("#game-state");
    if (!snapshot || container.clientHeight === 0) return;
    const hidden = new Set(preferences.hiddenFields[snapshot.state.source] ?? []);
    const all = Object.entries(snapshot.state.values);
    const fields = editingFields ? all : all.filter(([name]) => !hidden.has(name));
    query("#state-count").textContent = `${all.length - all.filter(([name]) => hidden.has(name)).length} / ${all.length}`;
    query("#field-settings").setAttribute("aria-pressed", String(editingFields));
    const size = capacity(container, editingFields ? 42 : 64);
    const start = pagination("state", fields.length, size);
    const current = fields.slice(start, start + size);
    const signature = `${editingFields}:${snapshot.state.source}:${current.map(([name]) => name).join(",")}`;
    if (signature !== stateSignature) {
      stateSignature = signature;
      const items = current.map(([name]) => {
        if (editingFields) {
          const item = document.createElement("label"); item.className = "field-choice";
          const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.dataset.field = name;
          checkbox.addEventListener("change", () => {
            const excluded = new Set(preferences.hiddenFields[snapshot.state.source] ?? []);
            if (checkbox.checked) excluded.delete(name); else excluded.add(name);
            preferences.hiddenFields[snapshot.state.source] = [...excluded];
            savePreferences(); renderState();
          });
          const title = document.createElement("span"); title.textContent = label(name); title.title = name;
          item.append(checkbox, title); return item;
        }
        const item = document.createElement("button"); item.type = "button"; item.className = "state-field"; item.dataset.field = name;
        item.setAttribute("aria-label", `Read ${label(name)} details`);
        const title = document.createElement("span"); title.className = "field-name"; title.textContent = label(name);
        const value = document.createElement("span"); value.className = "field-value";
        item.append(title, value);
        item.addEventListener("click", () => showDetail(label(name), String(snapshot.state.values[name]), snapshot.state.descriptions[name]));
        return item;
      });
      container.replaceChildren(...items);
      if (!items.length) empty(container, "All fields are hidden. Use Fields to show them again.");
    }
    for (const item of container.querySelectorAll("[data-field]")) {
      if (editingFields) item.checked = !hidden.has(item.dataset.field);
      else { item.querySelector(".field-value").textContent = String(snapshot.state.values[item.dataset.field]); item.title = `${item.dataset.field}: ${snapshot.state.values[item.dataset.field]}`; }
    }
  }

  function renderActions() {
    const container = query("#available-actions");
    if (!snapshot || container.clientHeight === 0) return;
    query("#actions-count").textContent = String(snapshot.actions.length);
    const size = capacity(container, 50);
    const start = pagination("actions", snapshot.actions.length, size);
    const actions = snapshot.actions.slice(start, start + size);
    const signature = JSON.stringify(actions);
    if (signature !== actionSignature) {
      actionSignature = signature;
      container.replaceChildren(...actions.map((action) => {
        const item = document.createElement("button"); item.type = "button"; item.className = "action-item"; item.dataset.action = action.id;
        item.setAttribute("aria-label", `Inspect action ${action.id}`); item.title = action.description;
        const title = document.createElement("strong"); title.textContent = action.id.replace(/^press_/, "").replaceAll("_", " ").toUpperCase();
        const duration = document.createElement("span"); duration.textContent = action.stop ? "End session" : action.execution === "profile" ? `Destination · up to ${action.frames} frames` : `${action.frames} frames · ${action.buttons.join(" + ") || "no input"}`;
        item.append(title, duration);
        item.addEventListener("click", () => showDetail(action.id, action.stop ? "Stop the session" : action.execution === "profile" ?
          `Profile destination executor\nFrame ceiling: ${action.frames}\nStops for interruptions; Jev chooses the next action.` :
          `Buttons: ${action.buttons.join(" + ") || "none"}\nDuration: ${action.frames} frames`, action.description));
        return item;
      }));
    }
    container.querySelectorAll("[data-action]").forEach((item) => item.classList.toggle("selected", item.dataset.action === selectedAction));
  }

  /** Measure actual wrapping so every character remains accessible without a scroll area. */
  function textPages(element, text, height) {
    if (height < 1) return [text];
    const result = [];
    for (let start = 0; start < text.length;) {
      let low = 1; let high = text.length - start; let length = 1;
      while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        element.textContent = text.slice(start, start + middle);
        if (element.scrollHeight <= height + 1) { length = middle; low = middle + 1; }
        else high = middle - 1;
      }
      if (length < text.length - start) {
        const part = text.slice(start, start + length);
        const boundary = Math.max(part.lastIndexOf("\n"), part.lastIndexOf(" "));
        if (boundary >= length * 0.65) length = boundary + 1;
        const last = text.charCodeAt(start + length - 1);
        if (last >= 0xd800 && last <= 0xdbff) length = length > 1 ? length - 1 : 2;
      }
      result.push(text.slice(start, start + length)); start += length;
    }
    return result.length ? result : [""];
  }

  function selectedExchange(value) {
    const selection = query("#exchange-request").value;
    const current = value?.exchange;
    const completed = value?.completed ?? (current?.status === "complete" ? current : null);
    return selection === "current" ? current : selection === "completed" ? completed :
      current?.status === "pending" ? completed ?? current : current;
  }

  function renderObservation() {
    exchange = selectedExchange(exchangeSnapshot);
    const sections = exchangeTab === "input" ? [["summary", "Summary"], ["objectives", "Objectives"], ["state", "Game state"],
      ["observation", "Observation"], ["actions", "Actions"], ["facts", "Game facts & routes"], ["history", "History"], ["feedback", "Repeated states"], ["question", "Question"], ["json", "Request JSON"]] :
      [["summary", "Summary"], ["probabilities", "Probabilities"], ["json", "Response fields"], ["decision", "Decision JSON"]];
    const select = query("#exchange-section");
    if (select.dataset.tab !== exchangeTab) {
      select.dataset.tab = exchangeTab;
      select.replaceChildren(...sections.map(([value, text]) => { const option = document.createElement("option"); option.value = value; option.textContent = text; return option; }));
    }
    select.value = exchangeSections[exchangeTab];
    for (const tab of document.querySelectorAll("[data-exchange-tab]")) {
      const selected = tab.dataset.exchangeTab === exchangeTab;
      tab.setAttribute("aria-selected", String(selected)); tab.tabIndex = selected ? 0 : -1;
    }
    const element = query("#agent-observation");
    const body = element.parentElement;
    body.setAttribute("aria-labelledby", `exchange-${exchangeTab}-tab`);
    body.dataset.format = exchangeSections[exchangeTab] === "summary" || exchangeSections[exchangeTab] === "observation" ? "text" : "json";
    const meta = query("#exchange-meta");
    meta.textContent = exchange ? `${exchange.provider === "mock" ? "Local mock" : exchange.provider === "typesafe" ? "TypeSafe" : "Gateway"} · Request ${exchange.id} · Frame ${exchange.frame} · ${exchange.status}${exchange.warnings.length ? " · Warning" : ""}` : "Waiting for the first decision request.";
    meta.title = meta.textContent; meta.dataset.status = exchange?.status ?? "idle";
    const text = exchangeText();
    if (body.clientHeight === 0) return;
    const cache = `${body.clientWidth}:${body.clientHeight}:${body.dataset.format}:${text}`;
    if (cache !== observationCache) { observationCache = cache; observationPages = textPages(element, text, body.clientHeight); }
    pagination("observation", observationPages.length, 1);
    element.textContent = observationPages[page.observation];
  }

  function exchangeText() {
    if (!exchange) return "The request and its matching response will appear here when the agent makes a decision.";
    const section = exchangeSections[exchangeTab];
    const state = exchange.request.state ?? {};
    const json = (value, fallback) => value === undefined || value === null ? fallback : JSON.stringify(value, null, 2);
    if (exchangeTab === "input") {
      if (section === "json") return json(exchange.request, "No request data.");
      if (exchange.request.unavailable) return exchange.request.unavailable;
      if (section === "question") return json(exchange.request.questions, "This provider uses the decision context directly. No remote typed question is sent.");
      if (section === "state") return json(state.gameState, "No semantic game reader is configured.");
      if (section === "observation") return state.observation || "No observation was supplied.";
      if (section === "objectives") return json(state.objectives, "No objectives were supplied.");
      if (section === "actions") return json(state.actions, "No actions were supplied.");
      if (section === "facts") return json(state.gameState?.decisionSupport, "This reader does not supply additional decision facts.");
      if (section === "history") return json(state.history, "No recent action history.");
      if (section === "feedback") return json(state.feedback, "No repetition feedback available.");
      return [`Objective\n${state.objectives?.goal ?? "Unavailable"}`, `Constraints\n${state.objectives?.constraints?.join("\n") || "None"}`,
        `Milestones\n${state.objectives?.milestones?.join("\n") || "None"}`,
        `Reader: ${state.gameState?.source ?? "None"}\nState fields: ${Object.keys(state.gameState?.values ?? {}).length}\nGame facts: ${state.gameState?.decisionSupport?.facts?.length ?? 0}\nAvailable actions: ${state.actions?.length ?? 0}\nRecent actions: ${state.history?.length ?? 0}\nUnchanged screens: ${state.unchangedScreens ?? 0}`,
        exchange.provider === "mock" ? "Local mock decision. No network request is made." : `Model: ${exchange.request.model ?? "Unavailable"}`].join("\n\n");
    }
    const response = exchange.response;
    const decision = exchange.decision;
    if (section === "json") return json(response, exchange.error || "Waiting for the response.");
    if (section === "decision") return json(decision, exchange.error || "No validated decision yet.");
    const answer = response?.answers?.next_action;
    const probabilities = answer?.probabilities ?? decision?.probabilities;
    if (section === "probabilities") return json(probabilities, exchange.error || "No probabilities received yet.");
    const choice = decision?.actionId ?? answer?.choice ?? "Waiting";
    const confidence = decision?.confidence ?? answer?.confidence ?? response?.providerMetadata?.typesafe?.confidence?.next_action;
    const usage = decision?.usage ?? response?.usage;
    const confidenceText = typeof confidence === "number" ? `${Number((confidence * 100).toFixed(2))}%` : "Unavailable";
    const tokens = (value) => typeof value === "number" ? String(value) : "Unavailable";
    return [`Status: ${exchange.status}\nSelected action: ${choice}\nConfidence: ${confidenceText}\nModel: ${decision?.model ?? response?.model ?? "Unavailable"}`,
      `Input tokens: ${tokens(usage?.inputTokens ?? usage?.input_tokens)}\nOutput tokens: ${tokens(usage?.outputTokens ?? usage?.output_tokens)}\nDecision time: ${exchange.durationMs === null ? exchange.status === "pending" ? "Pending" : "Unavailable" : `${exchange.durationMs} ms`}`,
      ...(exchange.warnings.length ? [`Warning\n${exchange.warnings.join("\n")}`] : []), ...(exchange.error ? [`${exchange.status === "cancelled" ? "Cancellation" : "Error"}\n${exchange.error}`] : [])].join("\n\n");
  }

  function renderDetail() {
    if (!dialog.open) return;
    const element = query("#detail-content");
    detailPages = textPages(element, detailText, element.clientHeight);
    pagination("detail", detailPages.length, 1);
    element.textContent = detailPages[page.detail];
  }

  function showDetail(title, value, description = "") {
    query("#detail-title").textContent = title;
    query("#detail-description").textContent = description ? "Full value and description" : "Full text";
    detailText = `${value}${description ? `\n\n${description}` : ""}`;
    page.detail = 0;
    if (!dialog.open) dialog.showModal();
    renderDetail();
  }

  function render() { renderState(); renderActions(); renderObservation(); renderDetail(); }

  for (const name of ["state", "actions", "observation", "detail"]) {
    for (const [direction, amount] of [["previous", -1], ["next", 1]]) query(`#${name}-${direction}`).addEventListener("click", () => { page[name] = Math.max(0, page[name] + amount); render(); });
  }
  document.querySelectorAll("[data-visibility]").forEach((input) => input.addEventListener("change", () => {
    preferences.panels[input.dataset.visibility] = input.checked; focused = false; expanded = null; savePreferences(); applyLayout();
  }));
  document.querySelectorAll("[data-expand]").forEach((button) => button.addEventListener("click", () => {
    expanded = expanded === button.dataset.expand ? null : button.dataset.expand;
    mobileTab = button.dataset.expand; applyLayout();
  }));
  document.querySelectorAll("[data-tab]").forEach((button) => button.addEventListener("click", () => {
    mobileTab = button.dataset.tab; expanded = null; applyLayout();
  }));
  query("#focus-game").addEventListener("change", (event) => {
    if (!event.target.checked) {
      focused = false;
      if (!panelNames.some(available)) preferences.panels = defaults().panels;
      savePreferences();
    } else focused = true;
    expanded = null; applyLayout();
  });
  query("#show-controller").addEventListener("change", (event) => { preferences.controller = event.target.checked; savePreferences(); applyLayout(); });
  query("#reset-layout").addEventListener("click", () => {
    preferences = defaults(); focused = false; expanded = null; editingFields = false; mobileTab = "game";
    page.state = 0; page.actions = 0; savePreferences(); applyLayout();
  });
  query("#field-settings").addEventListener("click", () => { editingFields = !editingFields; page.state = 0; renderState(); });
  query("#exchange-section").addEventListener("change", (event) => { exchangeSections[exchangeTab] = event.target.value; page.observation = 0; renderObservation(); });
  query("#exchange-request").addEventListener("change", () => { page.observation = 0; renderObservation(); });
  function selectExchangeTab(name) { exchangeTab = name; page.observation = 0; renderObservation(); }
  for (const tab of document.querySelectorAll("[data-exchange-tab]")) {
    tab.addEventListener("click", () => selectExchangeTab(tab.dataset.exchangeTab));
    tab.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === "Home" ? "input" : event.key === "End" ? "response" : exchangeTab === "input" ? "response" : "input";
      selectExchangeTab(next); query(`[data-exchange-tab="${next}"]`).focus();
    });
  }
  query("#close-detail").addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (event) => { if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close(); } });
  for (const [selector, title] of [["#agent-goal", "Objective"], ["#agent-stop", "Session stop reason"], ["#privacy-note", "Session privacy"]]) query(selector).addEventListener("click", (event) => showDetail(title, event.currentTarget.textContent));
  query("#open-settings").addEventListener("click", () => settings.showModal());
  query("#close-settings").addEventListener("click", () => settings.close());
  settings.addEventListener("click", (event) => {
    if (event.target === settings) { const rect = settings.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) settings.close(); }
  });
  function selectSettingsTab(name) {
    for (const tab of document.querySelectorAll("[data-settings-tab]")) {
      const selected = tab.dataset.settingsTab === name;
      tab.setAttribute("aria-selected", String(selected)); tab.tabIndex = selected ? 0 : -1;
      query(`#settings-${tab.dataset.settingsTab}`).hidden = !selected;
    }
    settings.dispatchEvent(new CustomEvent("settings-tab-change", { detail: name }));
  }
  for (const tab of document.querySelectorAll("[data-settings-tab]")) {
    tab.addEventListener("click", () => selectSettingsTab(tab.dataset.settingsTab));
    tab.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const names = [...document.querySelectorAll("[data-settings-tab]")].filter((button) => !button.hidden).map((button) => button.dataset.settingsTab);
      const index = names.indexOf(tab.dataset.settingsTab);
      const next = event.key === "Home" ? names[0] : event.key === "End" ? names.at(-1) : names[(index + (event.key === "ArrowRight" ? 1 : names.length - 1)) % names.length];
      selectSettingsTab(next); query(`[data-settings-tab="${next}"]`).focus();
    });
  }
  let resizePending = false;
  const resize = new ResizeObserver(() => {
    if (!resizePending) { resizePending = true; requestAnimationFrame(() => { resizePending = false; render(); }); }
  });
  for (const selector of ["#game-state", "#available-actions", ".observation-body", "#detail-content"]) resize.observe(query(selector));
  applyLayout();

  return {
    resetGame() {
      snapshot = undefined; exchange = null; exchangeSnapshot = null; exchangeRevision = -1; wantedExchangeRevision = 0;
      selectedAction = undefined; stateSignature = ""; actionSignature = ""; observationCache = "";
      observationPages = []; detailPages = []; detailText = "";
      for (const name of Object.keys(page)) page[name] = 0;
      if (dialog.open) dialog.close();
      empty(query("#game-state"), "Loading the current game state…");
      empty(query("#available-actions"), "Loading the current actions…");
      query("#state-count").textContent = "0 / 0"; query("#actions-count").textContent = "0";
      renderState(); renderActions(); renderObservation();
    },
    wantsSnapshot() { return !query("#game-state-panel").hidden || !query("#actions-panel").hidden; },
    wantsExchange() { return hasAgent && query("#observation-panel").clientHeight > 0 && exchangeRevision !== wantedExchangeRevision; },
    setExchange(value) {
      const next = selectedExchange(value);
      if (exchange?.id !== next?.id || exchange?.status !== next?.status) page.observation = 0;
      exchangeRevision = value.revision; exchangeSnapshot = value; renderObservation();
    },
    setSnapshot(value) {
      if (snapshot?.state.source !== value.state.source) page.state = 0;
      snapshot = value; renderState(); renderActions();
    },
    setStatus(status) {
      const agent = Boolean(status.agent);
      wantedExchangeRevision = status.agent?.exchange?.revision ?? 0;
      if (agent !== hasAgent || playerConfigurable !== Boolean(status.playerConfigurable)) {
        hasAgent = agent; playerConfigurable = Boolean(status.playerConfigurable); applyLayout();
      }
      selectedAction = status.agent?.action;
      query("#game-reader").textContent = status.gameReader === "emulator" ? "Emulator metadata · no semantic reader" : `Reader: ${status.gameReader}`;
      query("#game-reader").title = query("#game-reader").textContent;
      renderObservation(); renderActions();
    },
  };
}
