import { setImmediate as yieldTurn } from "node:timers/promises";
import type { Emulator } from "../core/emulator.js";
import { AgentSession } from "./agent-session.js";

export async function runAgentHeadless(emulator: Emulator, session: AgentSession, signal: AbortSignal, maxFrames = 1_000_000): Promise<void> {
  const start = emulator.frameNumber;
  const interrupt = () => session.stop("Session interrupted.");
  signal.addEventListener("abort", interrupt, { once: true });
  try {
    if (signal.aborted) interrupt();
    while (!session.terminal) {
      const remaining = maxFrames - (emulator.frameNumber - start);
      if (remaining <= 0) { session.stop("Headless frame limit reached."); break; }
      session.tick(Math.min(10, remaining));
      await session.waitForPending();
      await yieldTurn();
    }
  } finally { signal.removeEventListener("abort", interrupt); }
}
