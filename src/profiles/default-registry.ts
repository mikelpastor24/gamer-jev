import { DemoGameReader } from "./demo.js";
import { GameReaderRegistry } from "./registry.js";
import { createPokemonRedReader, POKEMON_RED_DESCRIPTOR } from "./pokemon/red.js";

export function createDefaultGameReaderRegistry(): GameReaderRegistry {
  const registry = new GameReaderRegistry();
  registry.register({ descriptor: new DemoGameReader().descriptor, create: () => new DemoGameReader() });
  registry.register({ descriptor: POKEMON_RED_DESCRIPTOR, create: createPokemonRedReader });
  return registry;
}
