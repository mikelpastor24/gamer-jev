import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Emulator } from "../core/emulator.js";
import { hasAudio, validateAction } from "../core/emulator.js";
import { encodePng, loadStateFile, saveStateFile } from "../emulator/files.js";
import type { AgentSession } from "../runner/agent-session.js";
import type { AgentSettings, GameStateProvider, PlayerSelection } from "../core/agent.js";
import type { GameRuntime } from "../runner/game-runtime.js";
import { createEmulatorStateProvider } from "../observation/state.js";
import { parseEmulationSpeed } from "../config/emulation.js";
import { FrameClock } from "./frame-clock.js";
import { LocalRomLibrary } from "./rom-library.js";

export interface ViewerOptions {
  readonly port: number;
  readonly speed: number;
  readonly paused: boolean;
  readonly checkpointPath: string;
  readonly checkpointDirectory?: string;
  readonly agent?: AgentSession;
  readonly gameState?: GameStateProvider;
  readonly record?: (event: unknown) => void;
  readonly romLibrary?: LocalRomLibrary;
  readonly loadRom?: (rom: Uint8Array, settings?: AgentSettings, selection?: PlayerSelection) => Promise<GameRuntime>;
  readonly dispose?: () => void;
  readonly runtime?: GameRuntime;
  readonly launcher?: boolean;
}

export interface Viewer {
  readonly url: string;
  readonly game: GameRuntime;
  readonly checkpointPath: string;
  setSpeed(speed: number): void;
  close(): Promise<void>;
}

export async function startViewer(emulator: Emulator, options: ViewerOptions): Promise<Viewer> {
  let speed = parseEmulationSpeed(options.speed);
  const [html, css, javascript, audioJavascript, inspectorJavascript, agentSettingsJavascript, romLibraryJavascript, settingsHelpJavascript] = await Promise.all([
    readFile(new URL("../../web/index.html", import.meta.url)),
    readFile(new URL("../../web/style.css", import.meta.url)),
    readFile(new URL("../../web/viewer.js", import.meta.url)),
    readFile(new URL("../../web/audio.js", import.meta.url)),
    readFile(new URL("../../web/inspector.js", import.meta.url)),
    readFile(new URL("../../web/agent-settings.js", import.meta.url)),
    readFile(new URL("../../web/rom-library.js", import.meta.url)),
    readFile(new URL("../../web/settings-help.js", import.meta.url)),
  ]);
  let paused = options.paused;
  let buttons: string[] = [];
  let inputAt = 0;
  let clock = new FrameClock(emulator.descriptor.framesPerSecond);
  let failure: string | null = null;
  let audioEpoch = 0;
  let agent = options.runtime?.agent ?? options.agent;
  let gameState = options.runtime?.gameState ?? options.gameState ?? createEmulatorStateProvider(emulator, 24);
  let record = options.runtime?.record ?? options.record;
  const initialEmulator = emulator;
  let game: GameRuntime = options.runtime ?? { emulator, gameState, ...(agent ? { agent } : {}), ...(record ? { record } : {}),
    dispose: options.dispose ?? (() => { options.agent?.stop("Session closed."); initialEmulator.dispose(); }) };
  let checkpointPath = options.checkpointPath;
  const romLibrary = options.romLibrary ?? new LocalRomLibrary("roms");
  let gameId = 0;
  let loadingRom = false;
  let closing = false;
  let mutation: Promise<void> | undefined;
  if (paused) agent?.pause();

  const discardAudio = () => { if (hasAudio(emulator)) emulator.drainAudio(); };
  const setSpeed = (value: unknown) => {
    const next = parseEmulationSpeed(value);
    if (next === speed) return;
    record?.({ type: "emulation-speed", from: speed, to: next, frame: emulator.frameNumber });
    speed = next; clock.reset(); audioEpoch++; discardAudio();
  };
  const pause = () => { paused = true; agent?.pause(); buttons = []; audioEpoch++; discardAudio(); };
  const audioPaused = () => paused || (agent !== undefined && !agent.advancing);
  const status = () => ({
    descriptor: emulator.descriptor,
    rom: emulator.rom,
    frame: emulator.frameNumber,
    paused,
    speed,
    error: failure,
    audioEpoch,
    audioPaused: audioPaused(),
    agent: agent?.snapshot ?? null,
    gameReader: gameState.id,
    gameId,
    loadingRom,
    romLibraryEnabled: options.loadRom !== undefined,
    playerConfigurable: game.player !== undefined,
    playerRevision: game.player?.configuration.revision ?? null,
    launcher: Boolean(options.launcher && gameId === 0),
  });
  const json = (response: ServerResponse, value: unknown, code = 200) => {
    response.writeHead(code, { "Content-Type": "application/json" });
    response.end(JSON.stringify(value));
  };

  const exclusive = async (operation: () => Promise<void>) => {
    const pending = operation(); mutation = pending;
    try { await pending; } finally { if (mutation === pending) mutation = undefined; }
  };
  const loadRom = async (id: unknown) => {
    if (!options.loadRom) throw new Error("ROM loading is unavailable in this viewer.");
    loadingRom = true; pause();
    let candidate: GameRuntime | undefined;
    try {
      candidate = await options.loadRom(await romLibrary.read(id), game.player?.copySettings() ?? agent?.copySettings(), game.player?.copySelection());
      candidate.agent?.pause();
      candidate.gameState.read(candidate.emulator.captureFrame());
      if (closing) throw new Error("The viewer is closing.");
      await saveStateFile(emulator, checkpointPath);
      if (closing) throw new Error("The viewer is closing.");
      const previous = game;
      previous.agent?.stop("ROM changed. A new session starts with fresh counters.");
      previous.record?.({ type: "rom-change", from: previous.emulator.rom.sha256, to: candidate.emulator.rom.sha256,
        frame: previous.emulator.frameNumber });
      game = candidate; candidate = undefined;
      emulator = game.emulator; agent = game.agent; gameState = game.gameState; record = game.record;
      checkpointPath = join(options.checkpointDirectory ?? "saves", emulator.descriptor.consoleId, emulator.rom.sha256, "checkpoint.json");
      clock = new FrameClock(emulator.descriptor.framesPerSecond);
      buttons = []; inputAt = 0; failure = null; gameId++; audioEpoch++; discardAudio();
      previous.dispose();
    } finally { candidate?.dispose(); loadingRom = false; }
  };

  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      if (!response.headersSent) json(response, { error: error instanceof Error ? error.message : "Request failed." }, 400);
      else response.end();
    });
  });

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Content-Security-Policy", "default-src 'self'; img-src 'self' blob:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'");
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : options.port;
    const expectedHost = `127.0.0.1:${port}`;
    if (request.headers.host !== expectedHost && request.headers.host !== `localhost:${port}`) {
      json(response, { error: "Invalid local viewer host." }, 403);
      return;
    }
    const path = new URL(request.url ?? "/", `http://${expectedHost}`).pathname;
    if (request.method === "GET") {
      const assets: Record<string, [Buffer, string]> = {
        "/": [html, "text/html; charset=utf-8"],
        "/style.css": [css, "text/css; charset=utf-8"],
        "/viewer.js": [javascript, "text/javascript; charset=utf-8"],
        "/audio.js": [audioJavascript, "text/javascript; charset=utf-8"],
        "/inspector.js": [inspectorJavascript, "text/javascript; charset=utf-8"],
        "/agent-settings.js": [agentSettingsJavascript, "text/javascript; charset=utf-8"],
        "/rom-library.js": [romLibraryJavascript, "text/javascript; charset=utf-8"],
        "/settings-help.js": [settingsHelpJavascript, "text/javascript; charset=utf-8"],
      };
      if (assets[path]) {
        const [data, contentType] = assets[path];
        response.writeHead(200, { "Content-Type": contentType });
        response.end(data);
      } else if (path === "/api/status") {
        json(response, status());
      } else if (path === "/api/roms") {
        json(response, { enabled: options.loadRom !== undefined, entries: await romLibrary.list() });
      } else if (path === "/api/frame") {
        const frame = emulator.captureFrame();
        response.writeHead(200, { "Content-Type": "application/octet-stream", "X-Frame-Number": String(frame.number), "X-Game-Id": String(gameId) });
        response.end(frame.pixels);
      } else if (path === "/api/game-state") {
        json(response, { ...gameState.read(emulator.captureFrame()), gameId });
      } else if (path === "/api/jev-exchange") {
        json(response, { ...(agent?.inspection ?? { revision: 0, exchange: null }), ...(gameId ? { gameId } : {}) });
      } else if (path === "/api/agent-settings") {
        if (!agent) json(response, { error: "Agent settings are unavailable during manual play." }, 400);
        else json(response, { ...agent.configuration, ...(gameId ? { gameId } : {}) });
      } else if (path === "/api/player-settings") {
        json(response, game.player ? { ...game.player.configuration, gameId } : { enabled: false });
      } else if (path === "/api/audio" && hasAudio(emulator)) {
        const audio = emulator.drainAudio();
        const data = Buffer.allocUnsafe(audioPaused() ? 0 : audio.samples.byteLength);
        for (let index = 0; index < data.length / 4; index++) data.writeFloatLE(audio.samples[index]!, index * 4);
        response.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "X-Audio-Format": "f32le",
          "X-Audio-Sample-Rate": String(audio.sampleRate),
          "X-Audio-Channels": String(audio.channels),
          "X-Audio-Epoch": String(audioEpoch),
          "X-Audio-Paused": String(audioPaused()),
          "X-Audio-Speed": String(speed),
          "X-Game-Id": String(gameId),
        });
        response.end(data);
      } else if (path === "/api/screenshot") {
        response.writeHead(200, { "Content-Type": "image/png", "Content-Disposition": 'attachment; filename="screenshot.png"' });
        response.end(encodePng(emulator.captureFrame()));
      } else json(response, { error: "Not found." }, 404);
      return;
    }
    if (request.method !== "POST") {
      json(response, { error: "Method not allowed." }, 405);
      return;
    }
    const origin = request.headers.origin;
    if ((origin && origin !== `http://${request.headers.host}`) ||
        request.headers["content-type"] !== "application/json") {
      json(response, { error: "Only same-origin JSON commands are accepted." }, 403);
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      const maximum = path === "/api/agent-settings" || path === "/api/player-settings" ? 32_768 : 4096;
      if (size > maximum) throw new Error(`Viewer commands must be at most ${maximum} bytes.`);
      chunks.push(chunk as Buffer);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (!body || typeof body !== "object") throw new Error("Invalid command body.");
    if (closing || mutation) throw new Error("A cartridge operation is in progress. Try again when it finishes.");
    const data = body as Record<string, unknown>;
    if (("gameId" in data && data.gameId !== gameId) || (gameId > 0 && !("gameId" in data))) {
      throw new Error("The game changed in another window. Reload the current game and try again.");
    }
    if (path === "/api/rom") {
      if (Object.keys(data).some((key) => key !== "id" && key !== "gameId") || data.gameId !== gameId) throw new Error("Invalid ROM loading command.");
      await exclusive(() => loadRom(data.id));
    } else if (path === "/api/speed") {
      const data = body as Record<string, unknown>;
      if (Object.keys(data).some((key) => key !== "speed" && key !== "gameId")) throw new Error("Invalid emulation speed command.");
      setSpeed(data.speed);
    } else if (path === "/api/player-settings") {
      if (!game.player) throw new Error("Player selection is unavailable in this viewer.");
      if (Object.keys(data).some((key) => !["selection", "settings", "revision", "gameId"].includes(key)) || data.gameId !== gameId) throw new Error("Invalid player settings command.");
      const previous = game.player.copySelection();
      game.player.configure(data.selection, data.settings, data.revision);
      pause();
      agent = game.agent; gameState = game.gameState; record = game.record;
      agent?.pause(); failure = null; clock.reset();
      if (JSON.stringify(previous) !== JSON.stringify(game.player.copySelection())) gameId++;
    } else if (path === "/api/agent-settings") {
      if (!agent) throw new Error("Agent settings are unavailable during manual play.");
      const data = body as Record<string, unknown>;
      if (Object.keys(data).some((key) => key !== "settings" && key !== "revision" && key !== "gameId")) throw new Error("Invalid agent settings command.");
      agent.updateSettings(data.settings, data.revision);
      pause(); failure = null;
    } else if (path === "/api/input") {
      const supplied = "buttons" in body ? body.buttons : undefined;
      if (!Array.isArray(supplied) || supplied.some((button: unknown) => typeof button !== "string")) throw new Error("Invalid buttons.");
      validateAction({ buttons: supplied, frames: 1 }, emulator.descriptor.buttons);
      if (agent && supplied.length) throw new Error("Controller input is managed by the agent in this session.");
      buttons = [...supplied];
      inputAt = performance.now();
    } else if (path === "/api/pause") {
      pause();
    } else if (path === "/api/resume") {
      agent?.resume();
      failure = null;
      audioEpoch++;
      discardAudio();
      clock.reset();
      paused = false;
    } else if (path === "/api/step") {
      pause();
      emulator.advance({ buttons: [], frames: 1 });
      if (game.player) game.player.clearHistory(); else agent?.clearHistory();
    } else if (path === "/api/reset") {
      pause();
      emulator.reset();
      if (game.player) game.player.clearHistory();
      else { agent?.clearHistory(); if (!agent) gameState.reset?.(); }
      failure = null;
    } else if (path === "/api/save") {
      await exclusive(() => saveStateFile(emulator, checkpointPath));
    } else if (path === "/api/load") {
      pause();
      await exclusive(() => loadStateFile(emulator, checkpointPath));
      if (game.player) game.player.clearHistory();
      else { agent?.clearHistory(); if (!agent) gameState.reset?.(); }
      failure = null;
    } else {
      json(response, { error: "Not found." }, 404);
      return;
    }
    json(response, status());
  };

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const timer = setInterval(() => {
    const now = performance.now();
    if (agent?.terminal && !paused) { failure = agent.snapshot.state === "error" ? agent.snapshot.stopReason : null; pause(); }
    if (paused) { clock.reset(now); return; }
    if (now - inputAt > 500) buttons = [];
    const frames = clock.dueFrames(now, speed);
    if (frames < 1) return;
    try {
      if (agent) {
        agent.tick(frames, true);
      } else emulator.advance({ buttons, frames });
    }
    catch (error) {
      failure = error instanceof Error ? error.message : "Emulation failed.";
      agent?.stop("Emulation failed.", true);
      pause();
    }
  }, 8);

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  return {
    url: `http://127.0.0.1:${port}`,
    get game() { return game; },
    get checkpointPath() { return checkpointPath; },
    setSpeed,
    async close() {
      clearInterval(timer);
      closing = true;
      pause();
      await mutation?.catch(() => {});
      agent?.stop("Viewer closed.");
      await closeServer(server);
    },
  };
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
