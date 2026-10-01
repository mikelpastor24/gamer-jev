import { AudioPlayer } from "./audio.js";

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

function message(text, error = false) {
  const element = document.querySelector("#message");
  element.textContent = text;
  element.classList.toggle("error", error);
}

async function request(path, body) {
  const response = await fetch(path, body === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
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
  if (!initialized || inputPending || agentMode) return;
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
    document.querySelector("#console-name").textContent = status.descriptor.name;
    document.querySelector("#resolution").textContent = `${canvas.width} × ${canvas.height}`;
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
  audio.setPaused(status.audioPaused ?? paused);
  document.querySelector("#run-state").textContent = status.error ? "Error" : paused ? "Paused" : status.agent?.state ?? "Running";
  document.querySelector("#toggle").textContent = paused ? "Resume" : "Pause";
  document.querySelector("#frame-number").textContent = status.frame.toLocaleString("en-US");
  document.querySelector("#speed").textContent = `${status.speed}×`;
  if (status.agent) {
    const agent = status.agent;
    document.querySelector("#agent-panel").hidden = false;
    document.querySelector("#session-mode").textContent = agent.mode === "mock" ? "Offline mock agent" : "Jev + vision";
    document.querySelector("#session-intro").textContent = "Watch the agent observe the screen and choose each controller input.";
    document.querySelector(".keyboard-hint").textContent = "Controller inputs are managed by the agent. You can pause, inspect, or restore a checkpoint.";
    document.querySelector("#privacy-note").textContent = agent.mode === "mock" ? "Mock mode runs locally without API calls." : "Live mode sends screenshots and observations through AI Gateway.";
    document.querySelector("#agent-goal").textContent = agent.goal;
    document.querySelector("#agent-state").textContent = agent.state;
    document.querySelector("#agent-decisions").textContent = `${agent.decisions} / ${agent.maxDecisions}`;
    document.querySelector("#agent-requests").textContent = `${agent.requests} / ${agent.maxRequests}`;
    document.querySelector("#agent-action").textContent = agent.action?.replace(/^press_/, "").replaceAll("_", " + ").toUpperCase() ?? "Waiting";
    document.querySelector("#agent-confidence").textContent = agent.confidence === null ? "Unavailable" : `${Math.round(agent.confidence * 100)}%`;
    document.querySelector("#agent-observation").textContent = agent.observation || "Waiting for the first observation.";
    document.querySelector("#agent-stop").textContent = agent.stopReason ?? "";
    document.querySelector("#toggle").disabled = agent.state === "stopped" || agent.state === "error";
  }
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
  if (!supported.includes(keyMap[event.code])) return;
  event.preventDefault(); keyboard.add(event.code); void sendInput();
});
window.addEventListener("keyup", (event) => {
  if (agentMode) return;
  if (!supported.includes(keyMap[event.code])) return;
  event.preventDefault(); keyboard.delete(event.code); void sendInput();
});
window.addEventListener("blur", clearInput);
document.addEventListener("visibilitychange", () => { if (document.hidden) clearInput(); });
document.addEventListener("visibilitychange", () => audio.reset());
window.addEventListener("pagehide", () => audio.mute());
setInterval(() => { if (!document.hidden) void sendInput(); }, 100);

async function poll() {
  try {
    if (!initialized || performance.now() - lastStatusAt > 500) {
      renderStatus(await request("/api/status"));
      lastStatusAt = performance.now();
    }
    const response = await fetch("/api/frame");
    if (!response.ok) throw new Error("Could not read the current frame.");
    const pixels = new Uint8ClampedArray(await response.arrayBuffer());
    if (pixels.length !== canvas.width * canvas.height * 4) throw new Error("Invalid screen data.");
    context.putImageData(new ImageData(pixels, canvas.width, canvas.height), 0, 0);
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
      if (generation === audio.generation) audio.play(samples,
        Number(response.headers.get("X-Audio-Sample-Rate")), Number(response.headers.get("X-Audio-Channels")),
        Number(response.headers.get("X-Audio-Speed")), Number(response.headers.get("X-Audio-Epoch")),
        response.headers.get("X-Audio-Paused") === "true");
    } catch (error) { audio.reset(); message(error.message, true); }
  }
  setTimeout(pollAudio, 40);
}
void pollAudio();
