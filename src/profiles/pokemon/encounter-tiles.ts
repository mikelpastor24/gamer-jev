/** Gen I uses different half-block tiles in Red/Blue and Yellow. Excludes water/shore cases. */
export function landEncounterTile(map: number, tileset: number, grass: number, left: number, right: number, yellow: boolean): boolean {
  if (left === 0x14 || left < 0 || right < 0) return false;
  return grass !== 255 && (yellow ? left : right) === grass || map >= 37 && tileset !== 3;
}
