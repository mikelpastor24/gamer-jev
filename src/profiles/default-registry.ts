import { DemoGameReader } from "./demo.js";
import { GameReaderRegistry } from "./registry.js";

export function createDefaultGameReaderRegistry(): GameReaderRegistry {
  const registry = new GameReaderRegistry();
  registry.register({ descriptor: new DemoGameReader().descriptor, create: () => new DemoGameReader() });
  return registry;
}
