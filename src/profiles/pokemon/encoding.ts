/** English Generation I character codes, not ASCII or a font asset. */
export function decodeCharacter(value: number): string | undefined {
  if (value >= 0x80 && value <= 0x99) return String.fromCharCode(65 + value - 0x80);
  if (value >= 0xa0 && value <= 0xb9) return String.fromCharCode(97 + value - 0xa0);
  if (value >= 0xf6 && value <= 0xff) return String(value - 0xf6);
  return punctuation[value];
}

const punctuation: Readonly<Record<number, string>> = {
  0x70: "'", 0x71: "'", 0x72: "\"", 0x73: "\"", 0x75: "…",
  0x7f: " ", 0x9a: "(", 0x9b: ")", 0x9c: ":", 0x9d: ";", 0x9e: "[", 0x9f: "]",
  0xba: "é", 0xbb: "'d", 0xbc: "'l", 0xbd: "'s", 0xbe: "'t", 0xbf: "'v",
  0xe0: "'", 0xe1: "POKé", 0xe2: "MON", 0xe3: "-", 0xe4: "'r", 0xe5: "'m",
  0xe6: "?", 0xe7: "!", 0xe8: ".", 0xec: ">", 0xed: ">", 0xee: "v",
  0xef: "♂", 0xf0: "$", 0xf1: "x", 0xf2: ".", 0xf3: "/", 0xf4: ",", 0xf5: "♀",
};

/** Require a terminator and known name characters; uninitialized RAM is not a name. */
export function decodeName(bytes: Uint8Array): string | undefined {
  const end = bytes.indexOf(0x50);
  if (end < 1) return undefined;
  const characters = Array.from(bytes.subarray(0, end), decodeCharacter);
  if (characters.some((character) => character === undefined)) return undefined;
  return characters.join("").trim() || undefined;
}

export function decodeBcd(bytes: Uint8Array): number | undefined {
  let value = 0;
  for (const byte of bytes) {
    const high = byte >>> 4; const low = byte & 15;
    if (high > 9 || low > 9) return undefined;
    value = value * 100 + high * 10 + low;
  }
  return value;
}

export function countBits(bytes: Uint8Array, bitLength = bytes.length * 8): number {
  let count = 0;
  for (let bit = 0; bit < bitLength; bit++) if ((bytes[bit >>> 3]! & (1 << (bit & 7))) !== 0) count++;
  return count;
}

export interface TextScreen {
  readonly top: string;
  readonly bottom: string;
  readonly hasBox: boolean;
  readonly cursor?: { readonly x: number; readonly y: number; readonly row: string };
  readonly naming?: { readonly prompt: string; readonly name: string };
}

/** Decode only inside complete text-box borders. Overworld graphics reuse letter tile IDs. */
export function readTextScreen(tiles: Uint8Array): TextScreen {
  const width = 20; const height = 18;
  if (tiles.length !== width * height) throw new Error("Generation I text screens require 20 by 18 tiles.");
  const inside = new Uint8Array(tiles.length);
  let hasBox = false;
  for (let y = 0; y < height - 2; y++) for (let x = 0; x < width - 2; x++) {
    if (tiles[y * width + x] !== 0x79) continue;
    let right = x + 1;
    while (right < width && tiles[y * width + right] === 0x7a) right++;
    if (right >= width || right <= x + 1 || tiles[y * width + right] !== 0x7b) continue;
    let bottom = y + 1;
    while (bottom < height && tiles[bottom * width + x] === 0x7c && tiles[bottom * width + right] === 0x7c) bottom++;
    if (bottom >= height || bottom <= y + 1 || tiles[bottom * width + x] !== 0x7d || tiles[bottom * width + right] !== 0x7e) continue;
    hasBox = true;
    for (let row = y + 1; row < bottom; row++) inside.fill(1, row * width + x + 1, row * width + right);
  }
  const rows = Array.from({ length: height }, (_, y) => Array.from({ length: width }, (_, x) =>
    inside[y * width + x] ? decodeCharacter(tiles[y * width + x]!) ?? " " : " ").join("").trim());
  const cursorIndex = tiles.findIndex((tile, index) => tile === 0xed && inside[index] === 1);
  const bounded = (part: readonly string[]) => part.filter(Boolean).join("\n").slice(0, 256);
  // The alphabet grid identifies a naming screen. Only then decode its unboxed heading and entry.
  const rawRow = (y: number) => Array.from(tiles.subarray(y * width, (y + 1) * width), (tile) => decodeCharacter(tile) ?? " ").join("").trim();
  const namingPrompt = rawRow(1);
  const naming = rows.some((row) => row.toUpperCase().includes("A B C D E F G H I")) && /^(YOUR|RIVAL's) NAME\??$/.test(namingPrompt);
  return { top: bounded(rows.slice(0, 9)), bottom: bounded(rows.slice(9)), hasBox,
    ...(cursorIndex < 0 ? {} : { cursor: { x: cursorIndex % width, y: Math.floor(cursorIndex / width), row: rows[Math.floor(cursorIndex / width)]! } }),
    ...(naming ? { naming: { prompt: namingPrompt, name: rawRow(2) } } : {}),
  };
}
