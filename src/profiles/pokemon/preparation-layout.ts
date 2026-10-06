/** Exact English cartridge tables; internal species IDs are not Pokedex numbers. */
export interface PokemonPreparationLayout {
  readonly trainerPointers: number; readonly wildPointers: number;
  readonly baseStats: number; readonly speciesNames: number; readonly pokedexOrder: number;
  readonly mewStats?: number;
}
export const RED_BLUE_PREPARATION: PokemonPreparationLayout = Object.freeze({
  trainerPointers: 0x39d3b, wildPointers: 0xceeb, baseStats: 0x383de,
  speciesNames: 0x1c21e, pokedexOrder: 0x41024, mewStats: 0x425b,
});
export const YELLOW_PREPARATION: PokemonPreparationLayout = Object.freeze({
  trainerPointers: 0x39dd1, wildPointers: 0xcb95, baseStats: 0x383de,
  speciesNames: 0xe8000, pokedexOrder: 0x410b1,
});
