import type { DecisionContext, DecisionProvider, ObservationProvider } from "../core/agent.js";

export function createMockProviders(): { observer: ObservationProvider; decider: DecisionProvider } {
  let decisionNumber = 0;
  return {
    observer: {
      async observe(frame, _previous, _objectives, signal) {
        signal.throwIfAborted();
        return { text: `Mock observation at frame ${frame.number}. Screen size ${frame.width} x ${frame.height}. This offline fixture does not interpret game content.`,
          model: "mock-observer", usage: { inputTokens: 0, outputTokens: 0 } };
      },
    },
    decider: {
      async decide(context: DecisionContext, signal) {
        signal.throwIfAborted();
        const candidates = context.actions.filter((action) => !action.stop);
        const sequence = ["press_right", "press_down", "press_left", "press_up", "press_a", "press_start", "wait"];
        const desired = sequence[decisionNumber++ % sequence.length];
        const action = candidates.find((candidate) => candidate.id === desired) ?? candidates[0]!;
        return { actionId: action.id, confidence: 1, probabilities: Object.fromEntries(context.actions.map((candidate) =>
          [candidate.id, candidate.id === action.id ? 1 : 0])), model: "mock-jev", usage: { inputTokens: 0, outputTokens: 0 } };
      },
    },
  };
}
