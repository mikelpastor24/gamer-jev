import type { GameReaderDescriptor } from "../../core/game-reader.js";
import { GenerationOnePokemonReader } from "./generation-one.js";
import { POKEMON_RED_BLUE_LAYOUT } from "./red-blue-layout.js";
import { RED_BLUE_NAVIGATION } from "./navigation-layout.js";
import { pokemonObjectives } from "./objectives.js";
import { RED_BLUE_BATTLE } from "./battle-layout.js";
import { RED_BLUE_PREPARATION } from "./preparation-layout.js";
import { RED_BLUE_ITEMS } from "./item-layout.js";

export const POKEMON_RED_DESCRIPTOR: GameReaderDescriptor = {
  id: "pokemon-red-en", name: "Pokémon Red (USA, Europe)", consoleId: "game-boy",
  romSha256: ["5ca7ba01642a3b27b0cc0b5349b52792795b62d3ed977e98a09390659af96b7b"],
};

export const POKEMON_RED_LAYOUT = POKEMON_RED_BLUE_LAYOUT;

export function createPokemonRedReader(): GenerationOnePokemonReader {
  return new GenerationOnePokemonReader(POKEMON_RED_DESCRIPTOR, POKEMON_RED_LAYOUT, RED_BLUE_NAVIGATION, pokemonObjectives("choice"), RED_BLUE_BATTLE, RED_BLUE_ITEMS, RED_BLUE_PREPARATION);
}
