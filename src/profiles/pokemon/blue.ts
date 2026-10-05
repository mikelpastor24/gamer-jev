import type { GameReaderDescriptor } from "../../core/game-reader.js";
import { GenerationOnePokemonReader } from "./generation-one.js";
import { POKEMON_RED_BLUE_LAYOUT } from "./red-blue-layout.js";
import { RED_BLUE_NAVIGATION } from "./navigation-layout.js";
import { pokemonObjectives } from "./objectives.js";
import { RED_BLUE_BATTLE } from "./battle-layout.js";
import { RED_BLUE_ITEMS } from "./item-layout.js";

// Exact English Blue release: SHA-1 d7037c83e1ae5b39bde3c30787637ba1d4c48ce2.
// Shares the verified Red/Blue RAM layout, not Red's ROM identity.
export const POKEMON_BLUE_DESCRIPTOR: GameReaderDescriptor = {
  id: "pokemon-blue-en", name: "Pokémon Blue (USA, Europe)", consoleId: "game-boy",
  romSha256: ["2a951313c2640e8c2cb21f25d1db019ae6245d9c7121f754fa61afd7bee6452d"],
};

export const POKEMON_BLUE_LAYOUT = POKEMON_RED_BLUE_LAYOUT;

export function createPokemonBlueReader(): GenerationOnePokemonReader {
  return new GenerationOnePokemonReader(POKEMON_BLUE_DESCRIPTOR, POKEMON_BLUE_LAYOUT, RED_BLUE_NAVIGATION, pokemonObjectives("choice"), RED_BLUE_BATTLE, RED_BLUE_ITEMS);
}
