import { parseArgs } from "node:util";

export interface CliOptions {
  help: boolean;
  listConsoles: boolean;
  listProfiles: boolean;
  consoleId: string;
  romPath: string | undefined;
  demo: boolean;
  headless: boolean;
  frames: number;
  buttons: string[];
  port: number;
  speed: number;
  paused: boolean;
  loadPath: string | undefined;
  savePath: string | undefined;
  screenshotPath: string | undefined;
  agent: "gateway" | "mock" | undefined;
  observationMode: "state" | "vision";
  profile: string | undefined;
  goal: string | undefined;
  objectivesPath: string | undefined;
  decisions: number;
  requests: number;
  maxSeconds: number;
  actionFrames: number;
}

function integer(value: string, name: string, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!value.trim() || !Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

export function parseCliOptions(args: string[]): CliOptions {
  const { values } = parseArgs({ args, options: {
    help: { type: "boolean", short: "h" },
    "list-consoles": { type: "boolean" },
    "list-profiles": { type: "boolean" },
    console: { type: "string", default: "game-boy" },
    rom: { type: "string" },
    demo: { type: "boolean" },
    headless: { type: "boolean" },
    frames: { type: "string" },
    buttons: { type: "string" },
    port: { type: "string", default: "8787" },
    speed: { type: "string", default: "1" },
    paused: { type: "boolean" },
    load: { type: "string" },
    save: { type: "string" },
    screenshot: { type: "string" },
    agent: { type: "string" },
    observation: { type: "string" },
    profile: { type: "string" },
    goal: { type: "string" },
    objectives: { type: "string" },
    decisions: { type: "string", default: "100" },
    requests: { type: "string", default: "300" },
    "max-seconds": { type: "string", default: "300" },
    "action-frames": { type: "string", default: "24" },
  }, strict: true, allowPositionals: false });
  const speed = Number(values.speed);
  if (!values.speed.trim() || !Number.isFinite(speed) || speed <= 0 || speed > 8) {
    throw new Error("--speed must be greater than 0 and at most 8.");
  }
  if (!values.help && !values["list-consoles"] && !values["list-profiles"]) {
    if (Boolean(values.rom) === Boolean(values.demo)) throw new Error("Supply exactly one of --rom <path> or --demo.");
    if (values.demo && values.console !== "game-boy") throw new Error("The synthetic demo is a Game Boy ROM.");
    if (!values.headless && (values.frames !== undefined || values.buttons !== undefined)) {
      throw new Error("--frames and --buttons require --headless.");
    }
    if (values.headless && values.paused) throw new Error("--paused is only available in the viewer.");
    if (!values.headless && values.screenshot) throw new Error("--screenshot requires --headless; the viewer has a screenshot button.");
    if (values.agent !== undefined && values.agent !== "gateway" && values.agent !== "mock") throw new Error("--agent must be gateway or mock.");
    if (values.observation !== undefined && values.observation !== "state" && values.observation !== "vision") throw new Error("--observation must be state or vision.");
    if (!values.agent && values.observation !== undefined) throw new Error("--observation requires an agent. --profile can inspect game state in manual mode.");
    if (values.profile !== undefined && !values.profile.trim()) throw new Error("--profile requires a registered ID or JSON file path.");
    if (values.agent && Boolean(values.goal) === Boolean(values.objectives)) throw new Error("Agent mode requires exactly one of --goal <text> or --objectives <path>.");
    if (values.agent && values.buttons !== undefined) throw new Error("--buttons cannot be combined with agent mode.");
    if (!values.agent && (values.goal !== undefined || values.objectives !== undefined || args.some((arg) => /^--(decisions|requests|max-seconds|action-frames)(=|$)/.test(arg)))) {
      throw new Error("Objectives and agent limits require --agent gateway or --agent mock.");
    }
  }
  return {
    help: values.help ?? false,
    listConsoles: values["list-consoles"] ?? false,
    listProfiles: values["list-profiles"] ?? false,
    consoleId: values.console,
    romPath: values.rom,
    demo: values.demo ?? false,
    headless: values.headless ?? false,
    frames: integer(values.frames ?? (values.agent ? "1000000" : "120"), "--frames", 1, 1_000_000),
    buttons: values.buttons === undefined ? [] : values.buttons.split(",").map((button) => button.trim().toUpperCase()),
    port: integer(values.port, "--port", 1, 65535),
    speed,
    paused: values.paused ?? false,
    loadPath: values.load,
    savePath: values.save,
    screenshotPath: values.screenshot,
    agent: values.agent as "gateway" | "mock" | undefined,
    observationMode: values.observation as "state" | "vision" | undefined ?? "vision",
    profile: values.profile,
    goal: values.goal,
    objectivesPath: values.objectives,
    decisions: integer(values.decisions, "--decisions", 1, 10_000),
    requests: integer(values.requests, "--requests", 1, 10_000),
    maxSeconds: integer(values["max-seconds"], "--max-seconds", 1, 86_400),
    actionFrames: integer(values["action-frames"], "--action-frames", 1, 600),
  };
}

export const CLI_HELP = `Usage: npm start -- --rom <path> [options]
       npm run demo

  --console <id>       Console adapter (default: game-boy)
  --list-consoles      List available adapters
  --list-profiles      List registered game readers
  --rom <path>         Your local Game Boy ROM
  --demo               Run the original synthetic demo ROM
  --headless           Run a finite number of frames without a viewer
  --frames <count>     Headless frame count (default: 120)
  --buttons <names>    Headless held inputs, e.g. RIGHT,A
  --port <number>      Local viewer port (default: 8787)
  --speed <factor>     Viewer speed, greater than 0 and at most 8 (default: 1)
  --paused             Start the viewer paused
  --load <path>        Restore a compatible checkpoint before running
  --save <path>        Checkpoint destination; saved at exit and from the viewer
  --screenshot <path>  Write the final headless frame as PNG
  --agent <provider>   Jev through gateway, or offline mock (omit for manual play)
  --observation <id>   state for memory only, or vision (default) for visual evidence
  --profile <id/path>  Registered game reader or a JSON memory profile
  --goal <text>        Primary objective for the agent
  --objectives <path>  JSON objectives instead of --goal
  --decisions <count>  Agent decision limit (default: 100)
  --requests <count>   Combined vision/Jev attempt limit (default: 300)
  --max-seconds <n>    Agent wall-clock limit, including pauses (default: 300)
  --action-frames <n>  Frames per chosen input, plus 4 release frames (default: 24)
  --help, -h           Show this help
`;
