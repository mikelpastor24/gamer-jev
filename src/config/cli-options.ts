import { parseArgs } from "node:util";

export interface CliOptions {
  help: boolean;
  listConsoles: boolean;
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
  }, strict: true, allowPositionals: false });
  const speed = Number(values.speed);
  if (!values.speed.trim() || !Number.isFinite(speed) || speed <= 0 || speed > 8) {
    throw new Error("--speed must be greater than 0 and at most 8.");
  }
  if (!values.help && !values["list-consoles"]) {
    if (Boolean(values.rom) === Boolean(values.demo)) throw new Error("Supply exactly one of --rom <path> or --demo.");
    if (values.demo && values.console !== "game-boy") throw new Error("The synthetic demo is a Game Boy ROM.");
    if (!values.headless && (values.frames !== undefined || values.buttons !== undefined)) {
      throw new Error("--frames and --buttons require --headless.");
    }
    if (values.headless && values.paused) throw new Error("--paused is only available in the viewer.");
    if (!values.headless && values.screenshot) throw new Error("--screenshot requires --headless; the viewer has a screenshot button.");
  }
  return {
    help: values.help ?? false,
    listConsoles: values["list-consoles"] ?? false,
    consoleId: values.console,
    romPath: values.rom,
    demo: values.demo ?? false,
    headless: values.headless ?? false,
    frames: integer(values.frames ?? "120", "--frames", 1, 1_000_000),
    buttons: values.buttons === undefined ? [] : values.buttons.split(",").map((button) => button.trim().toUpperCase()),
    port: integer(values.port, "--port", 1, 65535),
    speed,
    paused: values.paused ?? false,
    loadPath: values.load,
    savePath: values.save,
    screenshotPath: values.screenshot,
  };
}

export const CLI_HELP = `Usage: npm start -- --rom <path> [options]
       npm run demo

  --console <id>       Console adapter (default: game-boy)
  --list-consoles      List available adapters
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
  --help, -h           Show this help
`;
