/** Exact English release symbols; ROM offsets are absolute, RAM addresses are CPU addresses. */
export interface PokemonBattleLayout {
  readonly moves: number;
  readonly moveNames: number;
  readonly typeEffects: number;
  readonly menuY: number;
  readonly menuX: number;
  readonly menuItem: number;
  readonly menuMax: number;
  readonly watchedKeys: number;
  readonly swappingMove: number;
  readonly moveMenuType: number;
  readonly numMovesMinusOne: number;
  readonly disabledMove: number;
  readonly playerPartyIndex: number;
  readonly enemyPartyIndex: number;
  readonly playerStages: number;
  readonly enemyStages: number;
}

const shared = {
  moves: 0x38000,
  menuY: 0xcc24, menuX: 0xcc25, menuItem: 0xcc26, menuMax: 0xcc28, watchedKeys: 0xcc29,
  swappingMove: 0xcc35, moveMenuType: 0xccdb, numMovesMinusOne: 0xcd6c, playerPartyIndex: 0xcc2f,
  playerStages: 0xcd1a, enemyStages: 0xcd2e,
};

export const RED_BLUE_BATTLE: PokemonBattleLayout = Object.freeze({
  ...shared, moveNames: 0xb0000, typeEffects: 0x3e474, disabledMove: 0xd06d, enemyPartyIndex: 0xcfe8,
});
export const YELLOW_BATTLE: PokemonBattleLayout = Object.freeze({
  ...shared, moveNames: 0xbc000, typeEffects: 0x3e5fa, disabledMove: 0xd06c, enemyPartyIndex: 0xcfe7,
});
