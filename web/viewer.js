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
  if (!initialized || inputPending) return;
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
    canvas.width = status.descriptor.screen.width;
    canvas.height = status.descriptor.screen.height;
    document.querySelector("#game-title").textContent = status.rom.title;
    document.querySelector("#console-name").textContent = status.descriptor.name;
    document.querySelector("#resolution").textContent = `${canvas.width} × ${canvas.height}`;
    for (const name of supported) {
      const button = document.createElement("button");
      button.type = "button";
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
  document.querySelector("#run-state").textContent = status.error ? "Error" : paused ? "Paused" : "Running";
  document.querySelector("#toggle").textContent = paused ? "Resume" : "Pause";
  document.querySelector("#frame-number").textContent = status.frame.toLocaleString("en-US");
  document.querySelector("#speed").textContent = `${status.speed}×`;
  if (status.error) message(status.error, true);
}

async function command(path, success) {
  clearInput();
  try { renderStatus(await request(path, {})); if (success) message(success); }
  catch (error) { message(error.message, true); }
}

document.querySelector("#toggle").addEventListener("click", () => command(paused ? "/api/resume" : "/api/pause"));
document.querySelector("#step").addEventListener("click", () => command("/api/step"));
document.querySelector("#save").addEventListener("click", () => command("/api/save", "Checkpoint saved locally."));
document.querySelector("#load").addEventListener("click", () => command("/api/load", "Checkpoint restored. Resume when ready."));
document.querySelector("#reset").addEventListener("click", () => command("/api/reset", "Cartridge reset. Resume when ready."));
window.addEventListener("keydown", (event) => {
  if (!supported.includes(keyMap[event.code])) return;
  event.preventDefault(); keyboard.add(event.code); void sendInput();
});
window.addEventListener("keyup", (event) => {
  if (!supported.includes(keyMap[event.code])) return;
  event.preventDefault(); keyboard.delete(event.code); void sendInput();
});
window.addEventListener("blur", clearInput);
document.addEventListener("visibilitychange", () => { if (document.hidden) clearInput(); });
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
