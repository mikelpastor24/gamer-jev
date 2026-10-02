import { AudioPlayer } from "./audio.js";
import { createInspector } from "./inspector.js";
import { createAgentSettingsEditor } from "./agent-settings.js";
import { createRomLibrary } from "./rom-library.js";

const canvas = document.querySelector("#screen");
const context = canvas.getContext("2d");
const keyMap = { ArrowUp: "UP", ArrowDown: "DOWN", ArrowLeft: "LEFT", ArrowRight: "RIGHT", KeyZ: "A", KeyX: "B", Enter: "START", ShiftLeft: "SELECT", ShiftRight: "SELECT" };
const keyboard = new Set();
const pointers = new Map();
let supported = [];
let paused = false;
let inputPending = false;
let initialized = false;
let lastStatusAt = 0;
const audio = new AudioPlayer();
let audioSupported = false;
let agentMode = false;
let playbackSpeed;
let speedPending = false;
let gameId;
let loadingRom = false;
const speedControl = document.querySelector("#emulation-speed");
const inspector = createInspector((visible) => { if (!visible) clearInput(); });
const agentSettings = createAgentSettingsEditor({ request, message, onApply(status) { clearInput(); audio.reset(); renderStatus(status); } });
createRomLibrary({ request, message, onLoad(status) { renderStatus(status); } });

function message(text, error = false) {
  const element = document.querySelector("#message");
  element.textContent = text;
  element.classList.toggle("error", error);
  const settingsMessage = document.querySelector("#settings-message");
  settingsMessage.textContent = text;
  settingsMessage.hidden = !text;
  settingsMessage.classList.toggle("error", error);
}

async function request(path, body) {
  const response = await fetch(path, body === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ gameId, ...body }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "Request failed.");
  return data;
}

function heldButtons() {
  const buttons = new Set([...keyboard].map((key) => keyMap[key]));
  for (const button of pointers.values()) buttons.add(button);
  for (const [first, second] of [["UP", "DOWN"], ["LEFT", "RIGHT"]]) {
    if (buttons.has(first) && buttons.has(second)) { buttons.delete(first); buttons.delete(second); }
  }
  return [...buttons].filter((button) => supported.includes(button));
}

async function sendInput() {
  if (!initialized || inputPending || agentMode || loadingRom) return;
  inputPending = true;
  const buttons = heldButtons();
  document.querySelectorAll("#controller button").forEach((element) => element.classList.toggle("active", buttons.includes(element.dataset.button)));
  try { await request("/api/input", { buttons }); }
  catch (error) { message(error.message, true); }
  finally { inputPending = false; }
}

function clearInput() {
  keyboard.clear(); pointers.clear();
  void sendInput();
}

function renderStatus(status) {
  if (gameId !== undefined && status.gameId < gameId) return;
  if (gameId !== undefined && status.gameId !== gameId) {
    initialized = false; keyboard.clear(); pointers.clear(); audio.reset();
    inspector.resetGame(); agentSettings.reset(); lastStatusAt = 0;
    context.clearRect(0, 0, canvas.width, canvas.height);
  }
  gameId = status.gameId;
  loadingRom = status.loadingRom;
  if (!initialized) {
    supported = status.descriptor.buttons;
    agentMode = status.agent !== null && status.agent !== undefined;
    audioSupported = status.descriptor.capabilities.audio === true;
    document.querySelector("#sound").disabled = !audioSupported;
    document.querySelector("#volume").disabled = !audioSupported;
    if (!audioSupported) document.querySelector("#sound").textContent = "Audio unavailable";
    canvas.width = status.descriptor.screen.width;
    canvas.height = status.descriptor.screen.height;
    document.querySelector("#game-title").textContent = status.rom.title;
    document.querySelector("#game-title").title = status.rom.title;
    document.querySelector("#console-name").textContent = status.descriptor.name;
    document.querySelector("#resolution").textContent = `${canvas.width} × ${canvas.height}`;
    document.querySelector("#controller").replaceChildren();
    document.querySelector("#toggle").disabled = false;
    for (const name of supported) {
      const button = document.createElement("button");
      button.type = "button";
      button.disabled = agentMode;
      button.textContent = name;
      button.dataset.button = name;
      button.setAttribute("aria-label", `Hold ${name}`);
      button.addEventListener("pointerdown", (event) => {
        button.setPointerCapture(event.pointerId);
        pointers.set(event.pointerId, name);
        void sendInput();
      });
      const release = (event) => { pointers.delete(event.pointerId); void sendInput(); };
      button.addEventListener("pointerup", release);
      button.addEventListener("pointercancel", release);
      button.addEventListener("lostpointercapture", release);
      document.querySelector("#controller").append(button);
    }
    initialized = true;
  }
  paused = status.paused;
  if (playbackSpeed !== status.speed) { playbackSpeed = status.speed; audio.reset(); }
  audio.setPaused(status.audioPaused ?? paused);
  document.querySelector("#run-state").textContent = status.error ? "Error" : paused ? "Paused" : status.agent?.state ?? "Running";
  document.querySelector("#toggle").textContent = paused ? "Resume" : "Pause";
  document.querySelector("#frame-number").textContent = status.frame.toLocaleString("en-US");
  document.querySelector("#speed").textContent = `${status.speed}×`;
  if (!speedPending) {
    speedControl.querySelector('[data-custom-speed]')?.remove();
    if (![...speedControl.options].some((option) => Number(option.value) === status.speed)) {
      const option = document.createElement("option"); option.value = String(status.speed); option.textContent = `${status.speed}×`; option.dataset.customSpeed = "true";
      speedControl.append(option);
    }
    speedControl.value = String(status.speed);
  }
  if (status.agent) {
    const agent = status.agent;
    const liveDecisions = agent.mode !== "mock";
    const liveVision = agent.visionProvider === "gateway";
    const decisionDestination = agent.mode === "typesafe" ? "TypeSafe" : "Vercel AI Gateway";
    document.querySelector("#session-mode").textContent = agent.mode === "mock" ? liveVision ? "Mock decisions + vision" : "Offline mock agent" : agent.observationMode === "state" ? "Jev + game state" : "Jev + vision";
    document.querySelector("#session-intro").textContent = agent.observationMode === "state" ? "Watch the agent read the game state and choose each controller input." : "Watch the agent read game state and visual evidence, then choose each controller input.";
    document.querySelector(".keyboard-hint").textContent = "Controller inputs are managed by the agent. You can pause, inspect, or restore a checkpoint.";
    document.querySelector("#privacy-note").textContent = liveVision ?
      `Screenshots go to vision through Vercel AI Gateway. ${liveDecisions ? `State and observations go to Jev through ${decisionDestination}.` : "Decisions run locally."}` :
      liveDecisions ? `State and observations go to Jev through ${decisionDestination}. No screenshots are sent.` : "Mock mode runs locally without API calls.";
    document.querySelector("#agent-provider").textContent = liveDecisions ? agent.mode === "typesafe" ? "TypeSafe" : "Vercel" : "Mock";
    document.querySelector("#vision-provider").textContent = agent.visionProvider === "none" ? "Disabled" : liveVision ? "Vercel" : "Mock";
    document.querySelector("#agent-goal").textContent = agent.goal;
    document.querySelector("#agent-state").textContent = agent.state;
    document.querySelector("#agent-decisions").textContent = `${agent.decisions} / ${agent.maxDecisions ?? "∞"}`;
    document.querySelector("#agent-requests").textContent = `${agent.requests} / ${agent.maxRequests ?? "∞"}`;
    document.querySelector("#agent-action").textContent = agent.action?.replace(/^press_/, "").replaceAll("_", " + ").toUpperCase() ?? "Waiting";
    document.querySelector("#agent-confidence").textContent = agent.confidence === null ? "Unavailable" : `${Math.round(agent.confidence * 100)}%`;
    document.querySelector("#agent-stop").textContent = agent.stopReason ?? "";
    document.querySelector("#agent-stop").hidden = !agent.stopReason;
    document.querySelector("#toggle").disabled = agent.state === "stopped" || agent.state === "error";
  }
  inspector.setStatus(status);
  for (const id of ["save", "load", "reset", "step"]) document.querySelector(`#${id}`).disabled = loadingRom;
  if (loadingRom) document.querySelector("#toggle").disabled = true;
  else if (!status.agent) document.querySelector("#toggle").disabled = false;
  if (status.error) message(status.error, true);
}

async function command(path, success) {
  clearInput();
  if (path !== "/api/save") audio.reset();
  try { renderStatus(await request(path, {})); if (success) message(success); }
  catch (error) { message(error.message, true); }
}

document.querySelector("#toggle").addEventListener("click", () => command(paused ? "/api/resume" : "/api/pause"));
document.querySelector("#step").addEventListener("click", () => command("/api/step"));
document.querySelector("#save").addEventListener("click", () => command("/api/save", "Checkpoint saved locally."));
document.querySelector("#load").addEventListener("click", () => command("/api/load", "Checkpoint restored. Resume when ready."));
document.querySelector("#reset").addEventListener("click", () => command("/api/reset", "Cartridge reset. Resume when ready."));
speedControl.addEventListener("change", async () => {
  if (speedPending) return;
  const next = Number(speedControl.value);
  speedPending = true; speedControl.disabled = true;
  try {
    const status = await request("/api/speed", { speed: next });
    speedPending = false; renderStatus(status);
    message(`Emulation speed set to ${status.speed}×.`);
  } catch (error) {
    speedControl.value = String(playbackSpeed); message(error.message, true);
  } finally { speedPending = false; speedControl.disabled = false; }
});
document.querySelector("#sound").addEventListener("click", async () => {
  const button = document.querySelector("#sound");
  button.disabled = true;
  try {
    if (audio.enabled) audio.mute();
    else await audio.enable();
    button.textContent = audio.enabled ? "Mute sound" : "Enable sound";
    button.setAttribute("aria-pressed", String(audio.enabled));
  } catch (error) { message(error.message, true); }
  finally { button.disabled = false; }
});
document.querySelector("#volume").addEventListener("input", (event) => {
  audio.setVolume(Number(event.target.value) / 100);
  document.querySelector("#volume-value").textContent = `${event.target.value}%`;
});
window.addEventListener("keydown", (event) => {
  if (agentMode) return;
  if (document.querySelector("dialog[open]") || event.target.closest("input, select, textarea, summary, a, [contenteditable]") ||
      event.target.closest("button") && !event.target.closest("#controller")) return;
  if (!supported.includes(keyMap[event.code])) return;
  event.preventDefault(); keyboard.add(event.code); void sendInput();
});
window.addEventListener("keyup", (event) => {
  if (agentMode) return;
  if (!keyboard.has(event.code)) return;
  event.preventDefault(); keyboard.delete(event.code); void sendInput();
});
window.addEventListener("blur", clearInput);
canvas.addEventListener("pointerdown", () => canvas.focus());
document.addEventListener("focusin", (event) => {
  if (event.target.closest("input, select, textarea, summary, a, button, [contenteditable]") && !event.target.closest("#controller")) clearInput();
});
document.addEventListener("visibilitychange", () => { if (document.hidden) clearInput(); });
document.addEventListener("visibilitychange", () => audio.reset());
window.addEventListener("pagehide", () => audio.mute());
setInterval(() => { if (!document.hidden) void sendInput(); }, 100);

async function poll() {
  try {
    if (!initialized || performance.now() - lastStatusAt > 500) {
      renderStatus(await request("/api/status"));
      lastStatusAt = performance.now();
      if (inspector.wantsSnapshot()) {
        const snapshot = await request("/api/game-state");
        if (snapshot.gameId === gameId) inspector.setSnapshot(snapshot);
      }
      if (inspector.wantsExchange()) {
        const exchange = await request("/api/jev-exchange");
        if ((exchange.gameId ?? 0) === gameId) inspector.setExchange(exchange);
      }
    }
    const response = await fetch("/api/frame");
    if (!response.ok) throw new Error("Could not read the current frame.");
    const pixels = new Uint8ClampedArray(await response.arrayBuffer());
    if (Number(response.headers.get("X-Game-Id")) === gameId) {
      if (pixels.length !== canvas.width * canvas.height * 4) throw new Error("Invalid screen data.");
      context.putImageData(new ImageData(pixels, canvas.width, canvas.height), 0, 0);
    }
  } catch (error) { message(error.message, true); document.querySelector("#run-state").textContent = "Disconnected"; }
  setTimeout(poll, document.hidden ? 500 : 33);
}
void poll();

async function pollAudio() {
  if (audioSupported && audio.enabled && !document.hidden) {
    const generation = audio.generation;
    try {
      const response = await fetch("/api/audio");
      if (!response.ok || response.headers.get("X-Audio-Format") !== "f32le") throw new Error("Could not read game audio.");
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength % 4 !== 0) throw new Error("Invalid game audio data.");
      const samples = new Float32Array(bytes.byteLength / 4);
      const view = new DataView(bytes);
      for (let index = 0; index < samples.length; index++) samples[index] = view.getFloat32(index * 4, true);
      if (generation === audio.generation && Number(response.headers.get("X-Game-Id")) === gameId) audio.play(samples,
        Number(response.headers.get("X-Audio-Sample-Rate")), Number(response.headers.get("X-Audio-Channels")),
        Number(response.headers.get("X-Audio-Speed")), Number(response.headers.get("X-Audio-Epoch")),
        response.headers.get("X-Audio-Paused") === "true");
    } catch (error) { audio.reset(); message(error.message, true); }
  }
  setTimeout(pollAudio, 40);
}
void pollAudio();
