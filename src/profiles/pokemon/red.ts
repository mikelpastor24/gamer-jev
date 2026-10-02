import type { GameReaderDescriptor } from "../../core/game-reader.js";
import { GenerationOnePokemonReader } from "./generation-one.js";
import { POKEMON_RED_BLUE_LAYOUT } from "./red-blue-layout.js";

export const POKEMON_RED_DESCRIPTOR: GameReaderDescriptor = {
  id: "pokemon-red-en", name: "Pokémon Red (USA, Europe)", consoleId: "game-boy",
  romSha256: ["5ca7ba01642a3b27b0cc0b5349b52792795b62d3ed977e98a09390659af96b7b"],
};

export const POKEMON_RED_LAYOUT = POKEMON_RED_BLUE_LAYOUT;

export function createPokemonRedReader(): GenerationOnePokemonReader {
  return new GenerationOnePokemonReader(POKEMON_RED_DESCRIPTOR, POKEMON_RED_LAYOUT);
}
