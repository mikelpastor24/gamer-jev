import type { AgentAction } from "./agent.js";
import { validateAction } from "./emulator.js";

export function validateAgentActions(actions: readonly AgentAction[], buttons: readonly string[]): void {
  if (!Array.isArray(actions) || actions.length < 1 || actions.length > 255) throw new Error("Supply between 1 and 255 available actions.");
  const ids = new Set<string>();
  for (const action of actions) {
    if (!action || typeof action.id !== "string" || !/^[a-zA-Z][a-zA-Z0-9_:-]{0,63}$/.test(action.id) || ids.has(action.id)) throw new Error("Available actions require unique, stable identifiers of at most 64 characters.");
    ids.add(action.id);
    if (typeof action.description !== "string" || !action.description.trim() || action.description.length > 500 || typeof action.stop !== "boolean") throw new Error("Invalid available action description or stop flag.");
    if (action.availabilityKey !== undefined && (typeof action.availabilityKey !== "string" ||
        !action.availabilityKey.trim() || action.availabilityKey.length > 128)) throw new Error("Invalid action availability key.");
    if (action.execution !== undefined && (action.execution !== "profile" || action.stop || !Array.isArray(action.buttons) || action.buttons.length)) {
      throw new Error("Profile actions require a bounded executor and no fixed controller buttons.");
    }
    if (action.stop) {
      if (action.frames !== 0 || !Array.isArray(action.buttons) || action.buttons.length) throw new Error("Stop actions cannot press buttons or advance frames.");
    } else {
      validateAction(action, buttons);
      for (const [first, second] of [["UP", "DOWN"], ["LEFT", "RIGHT"]]) {
        if (action.buttons.includes(first!) && action.buttons.includes(second!)) throw new Error("Available actions cannot press opposite directions together.");
      }
    }
  }
}

export function controllerActions(buttons: readonly string[], frames: number): readonly AgentAction[] {
  const actions: AgentAction[] = buttons.map((button, index) => ({
    id: /^[A-Z][A-Z0-9_]*$/.test(button) ? `press_${button.toLowerCase()}` : `press_${button.toLowerCase().replace(/[^a-z0-9_]/g, "_")}_${index}`,
    description: `Hold ${button} for ${frames} frames, then release for 4 frames.`, buttons: [button], frames, stop: false,
  }));
  for (const direction of ["UP", "DOWN", "LEFT", "RIGHT"]) for (const button of ["A", "B"]) {
    if (buttons.includes(direction) && buttons.includes(button)) actions.push({
      id: `press_${direction.toLowerCase()}_${button.toLowerCase()}`,
      description: `Hold ${direction} and ${button} together for ${frames} frames, then release for 4 frames.`,
      buttons: [direction, button], frames, stop: false,
    });
  }
  actions.push({ id: "wait", description: `Wait ${frames} frames without pressing buttons.`, buttons: [], frames, stop: false },
    { id: "stop", description: "Stop this session. Completion remains unverified without a progress checker.", buttons: [], frames: 0, stop: true });
  validateAgentActions(actions, buttons);
  return actions;
}
