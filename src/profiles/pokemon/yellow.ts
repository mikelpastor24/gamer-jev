import type { GameReaderDescriptor } from "../../core/game-reader.js";
import { GenerationOnePokemonReader } from "./generation-one.js";
import type { GenerationOneLayout } from "./generation-one.js";
import { YELLOW_NAVIGATION } from "./navigation-layout.js";
import { pokemonObjectives } from "./objectives.js";
import { YELLOW_BATTLE } from "./battle-layout.js";
import { YELLOW_PREPARATION } from "./preparation-layout.js";
import { YELLOW_ITEMS } from "./item-layout.js";

export const POKEMON_YELLOW_DESCRIPTOR: GameReaderDescriptor = {
  id: "pokemon-yellow-en", name: "Pokémon Yellow (USA, Europe)", consoleId: "game-boy",
  romSha256: ["8cbaa499397e4f1a679c992ea9382a2dd7942ab398b48c19829c2d9529de47bf"],
};

// Exact English Yellow release: pret/pokeyellow symbols/pokeyellow.sym.
// SHA-1: cc7d03262ebfaf2f06772c1a480c7d9d5f4a38e1. See docs/pokemon-readers.md.
// Tile-map and sprite addresses match Red/Blue; many later fields do not.
export const POKEMON_YELLOW_LAYOUT: GenerationOneLayout = Object.freeze({
  tileMap: 0xc3a0, playerName: 0xd157, rivalName: 0xd349,
  partyCount: 0xd162, partyMons: 0xd16a, partyNicks: 0xd2b4,
  pokedexOwned: 0xd2f6, pokedexSeen: 0xd309, bagCount: 0xd31c, bagItems: 0xd31d,
  money: 0xd346, badges: 0xd355, mapId: 0xd35d, mapY: 0xd360, mapX: 0xd361,
  mapHeight: 0xd367, mapWidth: 0xd368, facing: 0xc109, movementMode: 0xd6ff,
  statusFlags5: 0xd72f, statusFlags6: 0xd731,
  battleKind: 0xd056, battleType: 0xd059, battleMon: 0xd013, battleNick: 0xd008,
  enemyMon: 0xcfe4, enemyNick: 0xcfd9, fontLoaded: 0xcfc3,
});

export function createPokemonYellowReader(): GenerationOnePokemonReader {
  return new GenerationOnePokemonReader(POKEMON_YELLOW_DESCRIPTOR, POKEMON_YELLOW_LAYOUT, YELLOW_NAVIGATION, pokemonObjectives("pikachu"), YELLOW_BATTLE, YELLOW_ITEMS, YELLOW_PREPARATION);
}
