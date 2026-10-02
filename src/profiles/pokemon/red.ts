import type { GameReaderDescriptor } from "../../core/game-reader.js";
import { GenerationOnePokemonReader } from "./generation-one.js";
import type { GenerationOneLayout } from "./generation-one.js";

export const POKEMON_RED_DESCRIPTOR: GameReaderDescriptor = {
  id: "pokemon-red-en", name: "Pokémon Red (USA, Europe)", consoleId: "game-boy",
  romSha256: ["5ca7ba01642a3b27b0cc0b5349b52792795b62d3ed977e98a09390659af96b7b"],
};

// Exact English Red release: pret/pokered symbols/pokered.sym and ram/wram.asm.
// SHA-1: ea9bcae617fdf159b045185467ae58b2e4a48b9a. See docs/pokemon-readers.md.
export const POKEMON_RED_LAYOUT: GenerationOneLayout = Object.freeze({
  tileMap: 0xc3a0, playerName: 0xd158, rivalName: 0xd34a,
  partyCount: 0xd163, partyMons: 0xd16b, partyNicks: 0xd2b5,
  pokedexOwned: 0xd2f7, pokedexSeen: 0xd30a, bagCount: 0xd31d, bagItems: 0xd31e,
  money: 0xd347, badges: 0xd356, mapId: 0xd35e, mapY: 0xd361, mapX: 0xd362,
  mapHeight: 0xd368, mapWidth: 0xd369, facing: 0xc109, movementMode: 0xd700,
  statusFlags5: 0xd730, statusFlags6: 0xd732,
  battleKind: 0xd057, battleType: 0xd05a, battleMon: 0xd014, battleNick: 0xd009,
  enemyMon: 0xcfe5, enemyNick: 0xcfda,
});

export function createPokemonRedReader(): GenerationOnePokemonReader {
  return new GenerationOnePokemonReader(POKEMON_RED_DESCRIPTOR, POKEMON_RED_LAYOUT);
}
