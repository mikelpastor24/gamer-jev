/** Verified English Gen I symbols. These are addresses, not extracted game assets. */
export interface PokemonNavigationLayout {
  readonly tileset: number;
  readonly bank: number;
  readonly blocks: number;
  readonly collision: number;
  /** Yellow collision lists moved to bank 1; block/gfx data still use the live tileset bank. */
  readonly collisionBank: number;
  readonly counters: number;
  readonly grass: number;
  readonly walkCounter: number;
  readonly warpCount: number;
  readonly warps: number;
  readonly lastMap: number;
  readonly connections: number;
  readonly spriteCount: number;
  readonly hiddenFlags: number;
  readonly hiddenList: number;
  readonly signCount: number;
  readonly signs: number;
  readonly strengthFlags: number;
  readonly tilePairs: number;
  readonly ledges: number;
}

export const RED_BLUE_NAVIGATION: PokemonNavigationLayout = Object.freeze({
  tileset: 0xd367, bank: 0xd52b, blocks: 0xd52c, collision: 0xd530, collisionBank: 0,
  counters: 0xd532, grass: 0xd535, walkCounter: 0xcfc5,
  warpCount: 0xd3ae, warps: 0xd3af, lastMap: 0xd365, connections: 0xd370,
  spriteCount: 0xd4e1, hiddenFlags: 0xd5a6, hiddenList: 0xd5ce,
  signCount: 0xd4b0, signs: 0xd4b1, strengthFlags: 0xd728, tilePairs: 0x0c7e, ledges: 6 * 0x4000 + 0x26cf,
});

export const YELLOW_NAVIGATION: PokemonNavigationLayout = Object.freeze({
  tileset: 0xd366, bank: 0xd52a, blocks: 0xd52b, collision: 0xd52f, collisionBank: 1,
  counters: 0xd531, grass: 0xd534, walkCounter: 0xcfc4,
  warpCount: 0xd3ad, warps: 0xd3ae, lastMap: 0xd364, connections: 0xd36f,
  spriteCount: 0xd4e0, hiddenFlags: 0xd5a5, hiddenList: 0xd5cd,
  signCount: 0xd4af, signs: 0xd4b0, strengthFlags: 0xd727, tilePairs: 0x0ada, ledges: 6 * 0x4000 + 0x2851,
});
