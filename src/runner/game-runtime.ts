import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Emulator } from "../core/emulator.js";
import type { AgentSettings, GameStateProvider } from "../core/agent.js";
import type { DiagnosticSink } from "../core/diagnostics.js";
import type { CliOptions } from "../config/cli-options.js";
import { loadObjectives, parseObjectives } from "../config/objectives.js";
import { createDefaultRegistry } from "../emulator/registry.js";
import { loadStateFile } from "../emulator/files.js";
import { createDefaultGameReaderRegistry } from "../profiles/default-registry.js";
import { bindGameReader } from "../profiles/registry.js";
import { loadJsonGameReader } from "../profiles/json.js";
import { createEmulatorStateProvider, createStateObserver } from "../observation/state.js";
import { withVision } from "../observation/combined.js";
import { RequestBudget } from "../providers/requests.js";
import { createDecisionProvider, createVisionProvider } from "../providers/factory.js";
import { redactLogEvent } from "../core/redaction.js";
import { AgentSession } from "./agent-session.js";
import { openSessionLog } from "./session-log.js";
import { createDiagnosticLogger } from "./diagnostics.js";

export interface GameRuntime {
  readonly emulator: Emulator;
  readonly gameState: GameStateProvider;
  readonly agent?: AgentSession;
  readonly record?: (event: unknown) => void;
  readonly logPath?: string;
  dispose(): void;
}

/** Build and validate a fresh cartridge session before replacing a working viewer. */
export async function createGameRuntime(rom: Uint8Array, options: CliOptions,
  settings?: AgentSettings, switching = false): Promise<GameRuntime> {
  const emulator = await createDefaultRegistry().create(options.consoleId, rom);
  let agent: AgentSession | undefined;
  let log: ReturnType<typeof openSessionLog> | undefined;
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true; agent?.stop("Session closed."); log?.close(); emulator.dispose();
  };
  try {
    if (!switching && options.loadPath) await loadStateFile(emulator, options.loadPath);
    let diagnostics: DiagnosticSink | undefined;
    const secrets = [process.env.TYPESAFE_API_KEY, process.env.AI_GATEWAY_API_KEY].filter((value): value is string => Boolean(value));
    let logPath: string | undefined;
    if (options.agent || options.debug) {
      logPath = join("logs", "sessions", `${randomUUID()}.jsonl`);
      log = openSessionLog(logPath, { secrets, onLimit: () => console.error("Local session log reached 32 MiB. Further file events are omitted; gameplay continues.") });
      diagnostics = createDiagnosticLogger(log.record, { verbose: options.debug, secrets });
    }
    const actionFrames = settings?.actionFrames ?? options.actionFrames;
    const readers = createDefaultGameReaderRegistry();
    let gameState: GameStateProvider | undefined;
    if (options.profile && existsSync(options.profile)) {
      const reader = await loadJsonGameReader(options.profile);
      if (!switching || reader.descriptor.consoleId === emulator.descriptor.consoleId && reader.descriptor.romSha256.includes(emulator.rom.sha256)) {
        gameState = bindGameReader(reader, emulator, actionFrames, diagnostics);
      }
    } else if (options.profile && (!switching || readers.list().some((reader) => reader.id === options.profile &&
        reader.consoleId === emulator.descriptor.consoleId && reader.romSha256.includes(emulator.rom.sha256)))) {
      gameState = readers.createFor(emulator, actionFrames, options.profile, diagnostics);
    }
    gameState ??= readers.createFor(emulator, actionFrames, undefined, diagnostics);
    const semanticState = gameState !== undefined;
    gameState ??= createEmulatorStateProvider(emulator, actionFrames);
    if (!semanticState) diagnostics?.({ component: "game-reader", level: "info", event: "metadata-only", frame: emulator.frameNumber,
      data: { console: emulator.descriptor.consoleId, romSha256: emulator.rom.sha256 } });
    gameState.read(emulator.captureFrame());
    if (options.agent) {
      if (options.observationMode === "state" && !semanticState) throw new Error("Memory-only agent mode requires a compatible game reader. Supply --profile <id/path>, or use --vision gateway.");
      const objectives = settings?.objectives ?? (options.objectivesPath ? await loadObjectives(options.objectivesPath) : parseObjectives({ goal: options.goal }));
      const budget = new RequestBudget({ maxRequests: settings ? settings.maxRequests : options.requests,
        timeoutMs: 20_000, intervalMs: 250, retries: 1 }, diagnostics);
      const providers = { environment: process.env, budget, ...(diagnostics ? { diagnostics } : {}) };
      const vision = createVisionProvider(options.visionProvider, providers);
      const stateObserver = createStateObserver(gameState);
      agent = new AgentSession(emulator, { observer: vision ? withVision(stateObserver, vision) : stateObserver,
        decider: createDecisionProvider(options.agent, providers), budget, mode: options.agent, visionProvider: options.visionProvider,
        objectives, actionFrames, maxDecisions: settings ? settings.maxDecisions : options.decisions,
        maxSeconds: settings ? settings.maxSeconds : options.maxSeconds,
        record: log!.record, ...(diagnostics ? { diagnostics } : {}),
        redactInspection: (value) => redactLogEvent(value, secrets),
      });
    }
    return { emulator, gameState, ...(agent ? { agent } : {}), ...(log ? { record: log.record } : {}),
      ...(logPath ? { logPath } : {}), dispose };
  } catch (error) { dispose(); throw error; }
}
