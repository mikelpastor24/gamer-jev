/** Exact English cartridge/RAM symbols. No item names or assets are bundled. */
export interface PokemonItemLayout {
  readonly names: number; readonly prices: number;
  readonly listPointer: number; readonly listId: number; readonly listCount: number;
  readonly scroll: number; readonly itemList: number; readonly printPrices: number; readonly quantity: number;
  readonly boxCount: number; readonly catchRate: number; readonly enemySpecies: number;
  readonly menuType: number; readonly stringBuffer: number; readonly nameLength: number; readonly submitName: number;
  readonly whichPokemon: number; readonly bagSaved: number; readonly pseudoItem: number; readonly boxNicks: number;
  readonly monDataLocation: number;
}
export const RED_BLUE_ITEMS: PokemonItemLayout = Object.freeze({
  names: 0x472b, prices: 0x4608, listPointer: 0xcf8b, listId: 0xcf94, listCount: 0xd12a,
  scroll: 0xcc36, itemList: 0xcf7b, printPrices: 0xcf93, quantity: 0xcf96,
  boxCount: 0xda80, catchRate: 0xd007, enemySpecies: 0xcfd8,
  menuType: 0xd07d, stringBuffer: 0xcf4b, nameLength: 0xcee9, submitName: 0xceea,
  whichPokemon: 0xcf92, bagSaved: 0xcc2c, pseudoItem: 0xd152, boxNicks: 0xde06, monDataLocation: 0xcc49,
});
export const YELLOW_ITEMS: PokemonItemLayout = Object.freeze({
  names: 0x45b7, prices: 0x4494, listPointer: 0xcf8a, listId: 0xcf93, listCount: 0xd129,
  scroll: 0xcc36, itemList: 0xcf7a, printPrices: 0xcf92, quantity: 0xcf95,
  boxCount: 0xda7f, catchRate: 0xd006, enemySpecies: 0xcfd7,
  menuType: 0xd07c, stringBuffer: 0xcf4a, nameLength: 0xcee9, submitName: 0xceea,
  whichPokemon: 0xcf91, bagSaved: 0xcc2c, pseudoItem: 0xd151, boxNicks: 0xde05, monDataLocation: 0xcc49,
});
