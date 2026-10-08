import assert from "node:assert/strict";
import type { EmulatorAction } from "../../src/core/emulator.js";
import { decodeCharacter } from "../../src/profiles/pokemon/encoding.js";
import { createPokemonRedReader, POKEMON_RED_LAYOUT } from "../../src/profiles/pokemon/red.js";
import { createPokemonBlueReader } from "../../src/profiles/pokemon/blue.js";
import { createPokemonYellowReader, POKEMON_YELLOW_LAYOUT } from "../../src/profiles/pokemon/yellow.js";
import { RED_BLUE_ITEMS, YELLOW_ITEMS } from "../../src/profiles/pokemon/item-layout.js";
import { RED_BLUE_BATTLE, YELLOW_BATTLE } from "../../src/profiles/pokemon/battle-layout.js";

export const teamVariants = [
  { name: "Red", mon: POKEMON_RED_LAYOUT, items: RED_BLUE_ITEMS, menu: RED_BLUE_BATTLE, create: createPokemonRedReader },
  { name: "Blue", mon: POKEMON_RED_LAYOUT, items: RED_BLUE_ITEMS, menu: RED_BLUE_BATTLE, create: createPokemonBlueReader },
  { name: "Yellow", mon: POKEMON_YELLOW_LAYOUT, items: YELLOW_ITEMS, menu: YELLOW_BATTLE, create: createPokemonYellowReader },
];
export const textCodes = new Map<string, number>();
for (let id = 0; id < 256; id++) { const character = decodeCharacter(id); if (character?.length === 1) textCodes.set(character, id); }
export const encodeTeamText = (text: string): number[] => [...text].map(character => {
  const code = textCodes.get(character); assert.notEqual(code, undefined); return code!;
});
const names = new Map([[4, "BALL"], [11, "PUREDROP"], [20, "SOOTHE"]]);

/** Invented cartridge metadata and menus. Every hardware frame repeats its input. */
export class PokemonTeamFixture {
  readonly ram = new Uint8Array(0x10000);
  readonly romBytes = new Uint8Array(64 * 0x4000);
  readonly romByteLength = this.romBytes.length;
  readonly inputs: string[] = [];
  confirmations = 0; submitted = "";
  mode: "command" | "party" | "confirm" | "bag" | "shop" | "use" | "naming" | "result" | "field" | "start" = "command";
  partyKind = 2; medicine = 0; row = 1; x = 1; entered = ""; upper = true;
  constructor(readonly variant = teamVariants[0]!) {
    const { mon, menu, items } = variant;
    this.ram[0xff40] = 0x80; this.ram[mon.statusFlags6] = 1;
    this.ram.set([...encodeTeamText("PLAYER"), 0x50], mon.playerName);
    this.ram[mon.mapId] = 13; this.ram[mon.mapWidth] = 4; this.ram[mon.mapHeight] = 4;
    this.ram[mon.partyCount] = 2; this.ram[mon.battleKind] = 1;
    for (let slot = 0; slot < 2; slot++) {
      const address = mon.partyMons + slot * 44;
      this.ram[address] = 176 + slot; this.ram[address + 33] = 10;
      this.be(address + 1, slot === 0 ? 10 : 30); this.be(address + 34, 40);
      this.ram.set([...encodeTeamText("TWIN"), 0x50], mon.partyNicks + slot * 11);
    }
    this.loadActive(0);
    this.ram[mon.enemyMon] = 19; this.ram[mon.enemyMon + 14] = 10;
    this.be(mon.enemyMon + 1, 40); this.be(mon.enemyMon + 15, 40);
    this.ram[items.enemySpecies] = 19; this.ram[items.catchRate] = 100;
    this.ram.set([0, 0x20, 0], mon.money);
    let offset = items.names;
    for (let id = 1; id <= 83; id++) {
      const label = names.get(id) ?? "UNKNOWN"; this.romBytes.set([...encodeTeamText(label), 0x50], offset); offset += label.length + 1;
      const price = id === 20 ? [0, 0x03, 0] : id === 11 ? [0, 0x01, 0] : [0, 0x02, 0];
      this.romBytes.set(price, items.prices + (id - 1) * 3);
    }
    this.bag([[20, 3], [11, 2], [4, 5]]); this.command();
    this.ram[menu.playerPartyIndex] = 0;
  }
  be(address: number, value: number): void { this.ram.set([value >> 8, value & 255], address); }
  hp(slot: number, hp: number, status = 0): void {
    const { mon, menu } = this.variant, address = mon.partyMons + slot * 44;
    this.be(address + 1, hp); this.ram[address + 4] = status;
    if (this.ram[menu.playerPartyIndex] === slot) { this.be(mon.battleMon + 1, hp); this.ram[mon.battleMon + 4] = status; }
  }
  loadActive(slot: number): void {
    const { mon, menu } = this.variant, source = mon.partyMons + slot * 44;
    this.ram[menu.playerPartyIndex] = slot; this.ram[mon.battleMon] = this.ram[source]!;
    this.ram.set(this.ram.subarray(source + 1, source + 7), mon.battleMon + 1);
    this.ram[mon.battleMon + 14] = this.ram[source + 33]!;
    this.ram.set(this.ram.subarray(source + 34, source + 36), mon.battleMon + 15);
  }
  tiles(): Uint8Array { return this.ram.subarray(this.variant.mon.tileMap, this.variant.mon.tileMap + 360); }
  box(x: number, y: number, right: number, bottom: number): void {
    const tiles = this.tiles();
    for (let row = y; row <= bottom; row++) {
      tiles[row * 20 + x] = row === y ? 0x79 : row === bottom ? 0x7d : 0x7c;
      tiles[row * 20 + right] = row === y ? 0x7b : row === bottom ? 0x7e : 0x7c;
      if (row === y || row === bottom) tiles.fill(0x7a, row * 20 + x + 1, row * 20 + right);
    }
  }
  command(x = 9, y = 14): void {
    const { menu } = this.variant; this.mode = "command"; this.tiles().fill(0x7f); this.box(0, 12, 19, 17);
    this.tiles().set(encodeTeamText("FIGHT"), 14 * 20 + 10); this.tiles().set(encodeTeamText("RUN"), 16 * 20 + 16);
    this.tiles()[y * 20 + x] = 0xed; this.ram[menu.menuX] = x; this.ram[menu.menuY] = y;
  }
  bag(entries: readonly (readonly [number, number])[]): void {
    const { mon } = this.variant; this.ram[mon.bagCount] = entries.length;
    this.ram.set([...entries.flat(), 255], mon.bagItems);
  }
  list(selected = 0, shop = false): void {
    const { mon, menu, items } = this.variant; this.mode = shop ? "shop" : "bag"; this.tiles().fill(0x7f); this.box(4, 2, 19, 12);
    if (shop) this.ram.set([3, 4, 20, 11, 255], items.itemList);
    const count = shop ? 3 : this.ram[mon.bagCount]!, pointer = shop ? items.itemList : mon.bagCount;
    this.ram.set([pointer & 255, pointer >> 8], items.listPointer); this.ram[items.listId] = shop ? 2 : 3;
    this.ram[items.listCount] = count; this.ram[items.printPrices] = shop ? 1 : 0;
    this.ram[menu.menuY] = 4; this.ram[menu.menuX] = 5; this.ram[menu.menuMax] = count < 2 ? 1 : 2; this.ram[menu.watchedKeys] = 7;
    const scroll = Math.max(0, selected - 2), cursor = selected - scroll; this.ram[items.scroll] = scroll; this.ram[menu.menuItem] = cursor;
    for (let row = 0; row < 4 && scroll + row <= count; row++) {
      const slot = scroll + row, id = shop ? this.ram[items.itemList + 1 + slot]! : this.ram[mon.bagItems + slot * 2]!;
      this.tiles().set(encodeTeamText(slot === count ? "CANCEL" : names.get(id) ?? "UNKNOWN"), (4 + row * 2) * 20 + 6);
    }
    this.tiles()[(4 + cursor * 2) * 20 + 5] = 0xed;
  }
  party(kind = 2, selected = 0): void {
    const { mon, menu, items } = this.variant; this.mode = "party"; this.partyKind = kind;
    this.tiles().fill(0x7f); this.box(0, 12, 19, 17);
    this.tiles().set(encodeTeamText(kind === 1 ? "Use item on which" : "CHOOSE A MEMBER"), 13 * 20 + 1);
    if (kind === 1) this.tiles().set(encodeTeamText("POKéMON?"), 15 * 20 + 1);
    this.ram[items.menuType] = kind; this.ram[items.monDataLocation] = 0;
    this.ram[menu.menuY] = 1; this.ram[menu.menuX] = 0; this.ram[menu.menuItem] = selected;
    this.ram[menu.menuMax] = this.ram[mon.partyCount]! - 1; this.ram[menu.watchedKeys] = 3;
    for (let slot = 0; slot < this.ram[mon.partyCount]!; slot++) {
      const bytes = this.ram.subarray(mon.partyNicks + slot * 11, mon.partyNicks + (slot + 1) * 11);
      this.tiles().set(bytes.subarray(0, bytes.indexOf(0x50)), slot * 2 * 20 + 3);
    }
    this.tiles()[(1 + selected * 2) * 20] = 0xed;
    // Match the real party renderer's aliased RAM, not the previous bag's values.
    this.ram[items.listId] = 2; this.ram[items.whichPokemon] = this.ram[mon.partyCount]! - 1;
    this.ram[items.whichPokemon - 1] = this.ram[mon.partyMons + (this.ram[mon.partyCount]! - 1) * 44]!;
    this.ram.fill(0, items.stringBuffer, items.stringBuffer + 13);
  }
  confirm(slot: number, selected = 0): void {
    const { menu, items } = this.variant; this.mode = "confirm"; this.tiles().fill(0x7f); this.box(11, 11, 19, 17);
    this.tiles().set(encodeTeamText("SWITCH"), 12 * 20 + 13); this.tiles().set(encodeTeamText("STATS"), 14 * 20 + 13);
    this.tiles().set(encodeTeamText("CANCEL"), 16 * 20 + 13); this.tiles()[(12 + selected * 2) * 20 + 12] = 0xed;
    this.ram[items.whichPokemon] = slot; this.ram[menu.menuY] = 12; this.ram[menu.menuX] = 12;
    this.ram[menu.menuItem] = selected; this.ram[menu.menuMax] = 2; this.ram[menu.watchedKeys] = 3;
  }
  use(selected = 0): void {
    const { menu } = this.variant; this.mode = "use"; this.tiles().fill(0x7f); this.box(13, 10, 19, 14);
    this.tiles().set(encodeTeamText("USE"), 11 * 20 + 15); this.tiles().set(encodeTeamText("TOSS"), 13 * 20 + 15);
    this.tiles()[(11 + selected * 2) * 20 + 14] = 0xed;
    this.ram[menu.menuY] = 11; this.ram[menu.menuX] = 14; this.ram[menu.menuMax] = 1; this.ram[menu.menuItem] = selected;
  }
  naming(entered = "", type = 2): void {
    const { mon, items, menu } = this.variant; this.mode = "naming"; this.entered = entered;
    this.tiles().fill(0x7f); this.box(0, 4, 19, 14);
    this.tiles().set(encodeTeamText(type === 2 ? "BIRD" : type === 0 ? "YOUR NAME?" : "RIVAL's NAME?"), 20 + (type === 2 ? 4 : 0));
    if (type === 2) this.tiles().set(encodeTeamText("NICKNAME?"), 3 * 20 + 1);
    for (let index = 0; index < 26; index++) {
      const char = String.fromCharCode((this.upper ? 65 : 97) + index);
      this.tiles()[((Math.floor(index / 9) + 1) * 2 + 3) * 20 + 2 + index % 9 * 2] = textCodes.get(char)!;
    }
    this.tiles()[(3 + this.row * 2) * 20 + this.x] = 0xed;
    this.ram[items.menuType] = type; this.ram[items.nameLength] = entered.length; this.ram[items.submitName] = 0;
    this.ram.set([...encodeTeamText(entered), 0x50], items.stringBuffer);
    this.ram[menu.menuItem] = this.row; this.ram[menu.menuX] = this.x;
    this.tiles().set(encodeTeamText(entered), 2 * 20 + 10);
    this.ram[mon.statusFlags5] = 0;
  }
  advance(action: EmulatorAction): void {
    for (let frame = 0; frame < action.frames; frame++) this.step(action.buttons[0] ?? "");
  }
  step(button: string): void {
    this.inputs.push(button);
    const { mon, menu, items } = this.variant;
    const cursor = this.ram[menu.menuItem]!;
    if (this.mode === "naming") {
      const type = this.ram[items.menuType]!;
      if (button === "UP") this.row = this.row === 1 ? 6 : this.row - 1;
      if (button === "DOWN") this.row = this.row === 6 ? 1 : this.row + 1;
      if (this.row === 6) this.x = 1;
      if (button === "LEFT" && this.row !== 6) this.x = this.x === 1 ? 17 : this.x - 2;
      if (button === "RIGHT" && this.row !== 6) this.x = this.x === 17 ? 1 : this.x + 2;
      if (button === "SELECT") this.upper = !this.upper;
      if (button === "B") this.entered = this.entered.slice(0, -1);
      if (button === "A" && this.row <= 3) this.entered += String.fromCharCode((this.upper ? 65 : 97) + (this.row - 1) * 9 + (this.x - 1) / 2);
      if (button === "START") { this.submitted = this.entered; this.mode = "result"; this.confirmations++; this.tiles().fill(0x7f); return; }
      this.naming(this.entered, type); return;
    }
    if (this.mode === "party") {
      if (button === "DOWN" || button === "UP") this.party(this.partyKind, (cursor + (button === "DOWN" ? 1 : this.ram[mon.partyCount]! - 1)) % this.ram[mon.partyCount]!);
      if (button === "A") {
        this.confirmations++;
        if (this.partyKind === 0 && this.ram[mon.battleKind]) this.confirm(cursor);
        else if (this.partyKind === 1) {
          const address = mon.partyMons + cursor * 44, maximum = this.ram[address + 34]! * 256 + this.ram[address + 35]!, hp = this.ram[address + 1]! * 256 + this.ram[address + 2]!;
          if (this.medicine === 11) this.ram[address + 4] = 0;
          else this.be(address + 1, Math.min(maximum, hp + 20));
          this.ram[mon.bagItems + (this.ram[items.bagSaved]! + this.ram[items.scroll]!) * 2 + 1]!--;
          if (cursor === this.ram[menu.playerPartyIndex]) this.loadActive(cursor);
          this.mode = "result"; this.tiles().fill(0x7f);
        } else { this.loadActive(cursor); this.command(); }
      }
    } else if (this.mode === "confirm") {
      const selected = this.ram[items.whichPokemon]!;
      if (button === "UP" || button === "DOWN") this.confirm(selected, (cursor + (button === "DOWN" ? 1 : 2)) % 3);
      if (button === "A" && cursor === 0) { this.confirmations++; this.loadActive(selected); this.command(); }
    } else if (this.mode === "bag") {
      const slot = this.ram[items.scroll]! + cursor;
      if (button === "UP" || button === "DOWN") this.list(Math.max(0, Math.min(this.ram[mon.bagCount]!, slot + (button === "DOWN" ? 1 : -1))));
      if (button === "A" && slot < this.ram[mon.bagCount]!) {
        this.confirmations++; this.medicine = this.ram[mon.bagItems + slot * 2]!; this.ram[items.bagSaved] = cursor;
        this.ram[items.whichPokemon - 1] = this.medicine;
        this.ram.set([...encodeTeamText(names.get(this.medicine)!), 0x50], items.stringBuffer);
        if (this.ram[mon.battleKind]) this.party(1); else this.use();
      }
    } else if (this.mode === "use") {
      if (button === "UP" || button === "DOWN") this.use(1 - cursor);
      if (button === "A" && cursor === 0) { this.confirmations++; this.party(1); }
    } else if (this.mode === "command") {
      if (button === "LEFT") this.command(9, this.ram[menu.menuY]);
      if (button === "RIGHT") this.command(15, this.ram[menu.menuY]);
      if (button === "UP") this.command(this.ram[menu.menuX], 14);
      if (button === "DOWN") this.command(this.ram[menu.menuX], 16);
      if (button === "A" && this.ram[menu.menuX] === 9 && this.ram[menu.menuY] === 16) this.list();
      else if (button === "A" && this.ram[menu.menuX] === 15 && this.ram[menu.menuY] === 14) this.party(0);
    }
  }
  readMemory(address: number, length: number): Uint8Array { return this.ram.slice(address, address + length); }
  readRom(offset: number, length: number): Uint8Array { assert.ok(length <= 0x4000); return this.romBytes.slice(offset, offset + length); }
}
