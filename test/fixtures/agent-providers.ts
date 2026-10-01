import { createMockDecisionProvider } from "../../src/jev/mock.js";
import { createMockVisionProvider } from "../../src/vision/mock.js";

/** Keep legacy controller-loop fixtures explicit without coupling production providers. */
export function createMockProviders() {
  return { observer: createMockVisionProvider(), decider: createMockDecisionProvider() };
}
