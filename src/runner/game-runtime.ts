import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Emulator } from "../core/emulator.js";
import type { AgentSettings, GameStateProvider, Objectives, PlayerSelection } from "../core/agent.js";
import type { DiagnosticSink } from "../core/diagnostics.js";
import type { CliOptions } from "../config/cli-options.js";
import { loadObjectives, parseObjectives } from "../config/objectives.js";
import { createDefaultRegistry } from "../emulator/registry.js";
import { defaultCheckpointPath, loadCheckpointIfPresent, loadStateFile } from "../emulator/files.js";
import { createDefaultGameReaderRegistry } from "../profiles/default-registry.js";
import { bindGameReader } from "../profiles/registry.js";
import type { GameReaderRegistry } from "../profiles/registry.js";
import { loadJsonGameReader } from "../profiles/json.js";
import { createEmulatorStateProvider, createStateObserver } from "../observation/state.js";
import { withVision } from "../observation/combined.js";
import { RequestBudget } from "../providers/requests.js";
import { createDecisionProvider, createVisionProvider } from "../providers/factory.js";
import { redactLogEvent } from "../core/redaction.js";
import { AgentSession } from "./agent-session.js";
import { openSessionLog } from "./session-log.js";
import { createDiagnosticLogger } from "./diagnostics.js";
import { parseAgentSettings } from "../config/agent-settings.js";
import { parsePlayerSelection, providerCatalog, validateProviderAccess } from "../config/player-settings.js";
import type { ProviderEnvironment } from "../config/player-settings.js";

export interface PlayerControl {
  readonly configuration: {
    readonly enabled: true;
    readonly revision: number;
    readonly selection: PlayerSelection;
    readonly settings: AgentSettings | null;
    readonly defaults: Omit<AgentSettings, "objectives">;
    readonly defaultObjectives: Objectives | null;
    readonly objectiveSource: "reader" | "user";
    readonly providers: ReturnType<typeof providerCatalog>;
  };
  configure(selection: unknown, settings: unknown, revision: unknown): void;
  copySettings(): AgentSettings | undefined;
  copySelection(): PlayerSelection;
  copyObjectiveSource(): "reader" | "user";
  clearHistory(): void;
}

export interface RuntimeProviders {
  /** Resume interactive startup before creating readers and agent sessions. */
  readonly resumeCheckpoint?: boolean;
  readonly selection?: PlayerSelection;
  readonly environment?: ProviderEnvironment;
  readonly fetch?: typeof globalThis.fetch;
  readonly objectiveSource?: "reader" | "user";
  readonly readers?: GameReaderRegistry;
}

export interface GameRuntime {
  readonly emulator: Emulator;
  readonly gameState: GameStateProvider;
  readonly agent?: AgentSession | undefined;
  readonly record?: ((event: unknown) => void) | undefined;
  readonly logPath?: string | undefined;
  readonly player?: PlayerControl;
  dispose(): void;
}

/** Build and validate a fresh cartridge session before replacing a working viewer. */
export async function createGameRuntime(rom: Uint8Array, options: CliOptions,
  settings?: AgentSettings, switching = false, providerOptions: RuntimeProviders = {}): Promise<GameRuntime> {
  const emulator = await createDefaultRegistry().create(options.consoleId, rom);
  let agent: AgentSession | undefined;
  let log: ReturnType<typeof openSessionLog> | undefined;
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true; agent?.stop("Session closed."); log?.close(); emulator.dispose();
  };
  try {
    if (!switching) {
      if (options.loadPath) await loadStateFile(emulator, options.loadPath);
      else if (providerOptions.resumeCheckpoint && !options.headless) {
        await loadCheckpointIfPresent(emulator, options.savePath ?? defaultCheckpointPath(emulator));
      }
    }
    const environment = { ...(providerOptions.environment ?? process.env) };
    const secrets = [environment.TYPESAFE_API_KEY, environment.AI_GATEWAY_API_KEY].filter((value): value is string => Boolean(value));
    const safe = <T>(value: T): T => redactLogEvent(value, secrets) as T;
    const catalog = providerCatalog(environment);
    const preferred = options.agent ?? (catalog.decisions.find((provider) => provider.available)?.id ?? "mock");
    let selection: PlayerSelection = providerOptions.selection ?? {
      mode: options.agent ? "agent" : "manual", decisionProvider: preferred as PlayerSelection["decisionProvider"],
      visionProvider: options.visionProvider,
      decisionModel: catalog.decisions.find((provider) => provider.id === preferred)!.model,
      visionModel: options.visionProvider === "gateway" ? catalog.vision.find((provider) => provider.id === "gateway")!.model : "",
    };
    let savedSettings = settings ? parseAgentSettings(settings, selection.mode === "manual") : undefined;
    let playerRevision = 0;
    let logger: DiagnosticSink | undefined;
    const diagnostics: DiagnosticSink = (event) => logger?.(event);
    let logPath: string | undefined;
    const ensureLog = () => {
      if (log) return;
      logPath = join("logs", "sessions", `${randomUUID()}.jsonl`);
      log = openSessionLog(logPath, { secrets, onLimit: () => console.error("Local session log reached its 32 MiB window. Oldest events are now replaced; recording and gameplay continue.") });
      logger = createDiagnosticLogger(log.record, { verbose: options.debug, secrets });
    };
    if (selection.mode === "agent" || options.debug) ensureLog();
    const actionFrames = settings?.actionFrames ?? options.actionFrames;
    const readers = providerOptions.readers ?? createDefaultGameReaderRegistry();
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
    const defaultObjectives = gameState.defaultObjectives ?? null;
    const userObjectives = !savedSettings && (options.objectivesPath || options.goal !== undefined) ?
      options.objectivesPath ? await loadObjectives(options.objectivesPath) : parseObjectives({ goal: options.goal }) : undefined;
    if (savedSettings && switching && providerOptions.objectiveSource === "reader") {
      savedSettings = parseAgentSettings({ ...savedSettings, objectives: defaultObjectives ?? { goal: "", constraints: [], milestones: [] } }, selection.mode === "manual");
    } else if (!savedSettings && (userObjectives || defaultObjectives)) {
      savedSettings = parseAgentSettings({ objectives: userObjectives ?? defaultObjectives,
        actionFrames, maxDecisions: options.decisions, maxRequests: options.requests, maxSeconds: options.maxSeconds }, selection.mode === "manual");
    }
    if (!semanticState) diagnostics?.({ component: "game-reader", level: "info", event: "metadata-only", frame: emulator.frameNumber,
      data: { console: emulator.descriptor.consoleId, romSha256: emulator.rom.sha256 } });
    if (savedSettings) gameState.setObjectives?.(savedSettings.objectives);
    gameState.read(emulator.captureFrame());
    const budget = new RequestBudget({ maxRequests: savedSettings ? savedSettings.maxRequests : options.requests,
      timeoutMs: 20_000, intervalMs: 250, retries: 1 }, diagnostics);
    const prepareProviders = (next: PlayerSelection) => {
      validateProviderAccess(next, environment);
      if (next.visionProvider === "none" && !semanticState) throw new Error("Memory-only agent mode requires a compatible game reader. Supply --profile <id/path>, or enable vision in Settings.");
      const providers = { environment: { ...environment,
        ...(next.decisionProvider === "typesafe" ? { TYPESAFE_MODEL: next.decisionModel } : { JEV_MODEL: next.decisionModel }),
        VISION_MODEL: next.visionModel }, budget, diagnostics, ...(providerOptions.fetch ? { fetch: providerOptions.fetch } : {}) };
      const vision = createVisionProvider(next.visionProvider, providers);
      const stateObserver = createStateObserver(gameState);
      return { observer: vision ? withVision(stateObserver, vision) : stateObserver,
        decider: createDecisionProvider(next.decisionProvider, providers), mode: next.decisionProvider, visionProvider: next.visionProvider };
    };
    const startAgent = (next: AgentSettings, providers: ReturnType<typeof prepareProviders>) => {
      ensureLog();
      gameState.reset?.();
      budget.setMaxRequests(next.maxRequests);
      return new AgentSession(emulator, { ...providers, budget, objectives: next.objectives, actionFrames: next.actionFrames,
        maxDecisions: next.maxDecisions, maxSeconds: next.maxSeconds, record: log!.record, diagnostics,
        redactInspection: (value) => safe(value),
      });
    };
    if (selection.mode === "agent") {
      if (!savedSettings) throw new Error("This game reader has no default objectives. Supply --goal or --objectives, or set an objective in Settings before enabling the agent.");
      agent = startAgent(savedSettings, prepareProviders(selection));
    }
    const player: PlayerControl = {
      get configuration() {
        return safe({ enabled: true as const, revision: playerRevision + (agent?.configuration.revision ?? 0), selection,
          settings: player.copySettings() ?? null,
          defaults: { actionFrames: options.actionFrames, maxDecisions: options.decisions, maxRequests: options.requests, maxSeconds: options.maxSeconds },
          defaultObjectives, objectiveSource: player.copyObjectiveSource(),
          providers: catalog });
      },
      copySettings: () => selection.mode === "manual" && savedSettings ? structuredClone(savedSettings) :
        agent?.copySettings() ?? (savedSettings ? structuredClone(savedSettings) : undefined),
      copySelection: () => ({ ...selection }),
      copyObjectiveSource: () => defaultObjectives && JSON.stringify(player.copySettings()?.objectives) === JSON.stringify(defaultObjectives) ? "reader" : "user",
      clearHistory() { if (agent) agent.clearHistory(); else gameState.reset?.(); },
      configure(value, valueSettings, revision) {
        if (disposed) throw new Error("The game session is closed.");
        if (revision !== playerRevision + (agent?.configuration.revision ?? 0)) throw new Error("Player settings changed in another window. Reload settings and try again.");
        const nextSelection = parsePlayerSelection(value);
        const suppliedSettings = valueSettings === null ? player.copySettings() : valueSettings;
        const nextSettings = suppliedSettings === undefined ? undefined : parseAgentSettings(suppliedSettings, nextSelection.mode === "manual");
        if (nextSelection.mode === "agent" && !nextSettings) throw new Error("Set an objective in Settings before enabling the agent.");
        const providers = nextSelection.mode === "agent" ? prepareProviders(nextSelection) : undefined;
        const changed = JSON.stringify(selection) !== JSON.stringify(nextSelection);
        // Everything above is read-only validation. Cancel work only after the update is accepted.
        if (agent) {
          const agentSettings = nextSelection.mode === "manual" && !nextSettings!.objectives.goal ?
            { ...nextSettings!, objectives: agent.copySettings().objectives } : nextSettings!;
          agent.updateSettings(agentSettings, agent.configuration.revision);
          if (providers && changed) agent.setProviders(providers);
          else if (changed) agent.clearHistory();
        } else {
          if (providers) { agent = startAgent(nextSettings!, providers); agent.pause(); }
          else if (nextSettings) gameState.setActionFrames?.(nextSettings.actionFrames);
          playerRevision++;
        }
        if (nextSelection.mode === "manual" && nextSettings) gameState.setObjectives?.(nextSettings.objectives);
        savedSettings = nextSettings; selection = nextSelection;
        log?.record({ type: "player-settings", selection, frame: emulator.frameNumber,
          decisions: agent?.snapshot.decisions ?? 0, requests: budget.requests });
      },
    };
    return { emulator, gameState, get agent() { return selection.mode === "agent" ? agent : undefined; },
      get record() { return log?.record; }, get logPath() { return logPath; }, player, dispose };
  } catch (error) { dispose(); throw error; }
}
