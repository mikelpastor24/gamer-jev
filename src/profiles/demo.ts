import { createHash } from "node:crypto";
import type { GameReader, GameStateData } from "../core/game-reader.js";
import type { AgentAction, GameState } from "../core/agent.js";
import type { MemoryReader } from "../core/emulator.js";
import { createDemoRom, DEMO_READY_ADDRESS } from "../demo/rom.js";

/** Example strategy for our original ROM; these semantics do not apply to other games. */
export class DemoGameReader implements GameReader {
  readonly descriptor = {
    id: "demo", name: "Scrolling checkerboard demo", consoleId: "game-boy",
    romSha256: [createHash("sha256").update(createDemoRom()).digest("hex")],
  };

  readState(memory: MemoryReader): GameStateData {
    const lcdEnabled = (memory.readMemory(0xff40, 1)[0]! & 0x80) !== 0;
    const ready = lcdEnabled && memory.readMemory(DEMO_READY_ADDRESS, 1)[0] === 1;
    return { values: { phase: ready ? "running" : "initializing", lcdEnabled,
      scrollX: memory.readMemory(0xff43, 1)[0]!, scrollY: memory.readMemory(0xff42, 1)[0]! },
      descriptions: {
        phase: "Running when the ROM's work-RAM readiness flag is set and the LCD is enabled; otherwise initializing.",
        lcdEnabled: "Whether the LCD is enabled.",
        scrollX: "Horizontal checkerboard offset. RIGHT increases it; LEFT decreases it. Wraps modulo 256.",
        scrollY: "Vertical checkerboard offset. DOWN increases it; UP decreases it. Wraps modulo 256.",
      } };
  }

  availableActions(state: GameState, actions: readonly AgentAction[]): readonly AgentAction[] {
    return actions.filter((action) => action.id === "wait" || action.stop ||
      state.values.phase === "running" && action.buttons.length === 1 && ["UP", "DOWN", "LEFT", "RIGHT"].includes(action.buttons[0]!));
  }
}
