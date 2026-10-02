import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Emulator } from "../core/emulator.js";
import { hasAudio, validateAction } from "../core/emulator.js";
import { encodePng, loadStateFile, saveStateFile } from "../emulator/files.js";
import type { AgentSession } from "../runner/agent-session.js";
import type { GameStateProvider } from "../core/agent.js";
import { createEmulatorStateProvider } from "../observation/state.js";

export interface ViewerOptions {
  readonly port: number;
  readonly speed: number;
  readonly paused: boolean;
  readonly checkpointPath: string;
  readonly agent?: AgentSession;
  readonly gameState?: GameStateProvider;
}

export interface Viewer {
  readonly url: string;
  close(): Promise<void>;
}

export async function startViewer(emulator: Emulator, options: ViewerOptions): Promise<Viewer> {
  const [html, css, javascript, audioJavascript, inspectorJavascript, agentSettingsJavascript] = await Promise.all([
    readFile(new URL("../../web/index.html", import.meta.url)),
    readFile(new URL("../../web/style.css", import.meta.url)),
    readFile(new URL("../../web/viewer.js", import.meta.url)),
    readFile(new URL("../../web/audio.js", import.meta.url)),
    readFile(new URL("../../web/inspector.js", import.meta.url)),
    readFile(new URL("../../web/agent-settings.js", import.meta.url)),
  ]);
  let paused = options.paused;
  let buttons: string[] = [];
  let inputAt = 0;
  let lastTick = performance.now();
  let failure: string | null = null;
  let audioEpoch = 0;
  const agent = options.agent;
  const gameState = options.gameState ?? createEmulatorStateProvider(emulator, 24);
  if (paused) agent?.pause();

  const discardAudio = () => { if (hasAudio(emulator)) emulator.drainAudio(); };
  const pause = () => { paused = true; agent?.pause(); buttons = []; audioEpoch++; discardAudio(); };
  const audioPaused = () => paused || (agent !== undefined && !agent.advancing);
  const status = () => ({
    descriptor: emulator.descriptor,
    rom: emulator.rom,
    frame: emulator.frameNumber,
    paused,
    speed: options.speed,
    error: failure,
    audioEpoch,
    audioPaused: audioPaused(),
    agent: agent?.snapshot ?? null,
    gameReader: gameState.id,
  });
  const json = (response: ServerResponse, value: unknown, code = 200) => {
    response.writeHead(code, { "Content-Type": "application/json" });
    response.end(JSON.stringify(value));
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
      };
      if (assets[path]) {
        const [data, contentType] = assets[path];
        response.writeHead(200, { "Content-Type": contentType });
        response.end(data);
      } else if (path === "/api/status") {
        json(response, status());
      } else if (path === "/api/frame") {
        const frame = emulator.captureFrame();
        response.writeHead(200, { "Content-Type": "application/octet-stream", "X-Frame-Number": String(frame.number) });
        response.end(frame.pixels);
      } else if (path === "/api/game-state") {
        json(response, gameState.read(emulator.captureFrame()));
      } else if (path === "/api/jev-exchange") {
        json(response, agent?.inspection ?? { revision: 0, exchange: null });
      } else if (path === "/api/agent-settings") {
        if (!agent) json(response, { error: "Agent settings are unavailable during manual play." }, 400);
        else json(response, agent.configuration);
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
          "X-Audio-Speed": String(options.speed),
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
      const maximum = path === "/api/agent-settings" ? 32_768 : 4096;
      if (size > maximum) throw new Error(`Viewer commands must be at most ${maximum} bytes.`);
      chunks.push(chunk as Buffer);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (!body || typeof body !== "object") throw new Error("Invalid command body.");
    if (path === "/api/agent-settings") {
      if (!agent) throw new Error("Agent settings are unavailable during manual play.");
      const data = body as Record<string, unknown>;
      if (Object.keys(data).some((key) => key !== "settings" && key !== "revision")) throw new Error("Invalid agent settings command.");
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
      lastTick = performance.now();
      paused = false;
    } else if (path === "/api/step") {
      pause();
      emulator.advance({ buttons: [], frames: 1 });
      agent?.clearHistory();
    } else if (path === "/api/reset") {
      pause();
      emulator.reset();
      agent?.clearHistory();
      if (!agent) gameState.reset?.();
      failure = null;
    } else if (path === "/api/save") {
      await saveStateFile(emulator, options.checkpointPath);
    } else if (path === "/api/load") {
      pause();
      await loadStateFile(emulator, options.checkpointPath);
      agent?.clearHistory();
      if (!agent) gameState.reset?.();
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
    if (paused) { lastTick = now; return; }
    if (now - inputAt > 500) buttons = [];
    const interval = 1000 / (emulator.descriptor.framesPerSecond * options.speed);
    const frames = Math.min(3, Math.floor((now - lastTick) / interval));
    if (frames < 1) return;
    lastTick = Math.max(lastTick + frames * interval, now - 3 * interval);
    try {
      if (agent) {
        const wasAdvancing = agent.advancing;
        agent.tick(frames);
        if (!agent.advancing) lastTick = now;
        if (wasAdvancing && !agent.advancing) { audioEpoch++; discardAudio(); }
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
    async close() {
      clearInterval(timer);
      pause();
      agent?.stop("Viewer closed.");
      await closeServer(server);
    },
  };
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
