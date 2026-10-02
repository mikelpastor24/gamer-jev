import { DemoGameReader } from "./demo.js";
import { GameReaderRegistry } from "./registry.js";
import { createPokemonRedReader, POKEMON_RED_DESCRIPTOR } from "./pokemon/red.js";
import { createPokemonBlueReader, POKEMON_BLUE_DESCRIPTOR } from "./pokemon/blue.js";
import { createPokemonYellowReader, POKEMON_YELLOW_DESCRIPTOR } from "./pokemon/yellow.js";

export function createDefaultGameReaderRegistry(): GameReaderRegistry {
  const registry = new GameReaderRegistry();
  registry.register({ descriptor: new DemoGameReader().descriptor, create: () => new DemoGameReader() });
  registry.register({ descriptor: POKEMON_RED_DESCRIPTOR, create: createPokemonRedReader });
  registry.register({ descriptor: POKEMON_BLUE_DESCRIPTOR, create: createPokemonBlueReader });
  registry.register({ descriptor: POKEMON_YELLOW_DESCRIPTOR, create: createPokemonYellowReader });
  return registry;
}
