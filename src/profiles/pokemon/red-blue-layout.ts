import type { GenerationOneLayout } from "./generation-one.js";

// The exact English Red and Blue releases share these work-RAM addresses.
// Checked against both pret/pokered symbol files; see docs/pokemon-readers.md.
export const POKEMON_RED_BLUE_LAYOUT: GenerationOneLayout = Object.freeze({
  tileMap: 0xc3a0, playerName: 0xd158, rivalName: 0xd34a,
  partyCount: 0xd163, partyMons: 0xd16b, partyNicks: 0xd2b5,
  pokedexOwned: 0xd2f7, pokedexSeen: 0xd30a, bagCount: 0xd31d, bagItems: 0xd31e,
  money: 0xd347, badges: 0xd356, mapId: 0xd35e, mapY: 0xd361, mapX: 0xd362,
  mapHeight: 0xd368, mapWidth: 0xd369, facing: 0xc109, movementMode: 0xd700,
  statusFlags5: 0xd730, statusFlags6: 0xd732,
  battleKind: 0xd057, battleType: 0xd05a, battleMon: 0xd014, battleNick: 0xd009,
  enemyMon: 0xcfe5, enemyNick: 0xcfda,
});
