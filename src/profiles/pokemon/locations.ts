/** Verified English Gen I map identifiers; unknown maps retain their numeric ID. */
const locations: Readonly<Record<number, string>> = {
  0: "Pallet Town", 1: "Viridian City", 2: "Pewter City", 3: "Cerulean City",
  4: "Lavender Town", 5: "Vermilion City", 6: "Celadon City", 7: "Fuchsia City",
  8: "Cinnabar Island", 9: "Indigo Plateau", 10: "Saffron City",
  37: "Player's house, ground floor", 38: "Player's house, upper floor",
  39: "Rival's house", 40: "Oak's laboratory",
  41: "Viridian Pokemon Center", 42: "Viridian Poke Mart",
  46: "Diglett's Cave, Route 2 entrance", 47: "Viridian Forest north gate",
  48: "Route 2 trade house", 49: "Route 2 gate", 50: "Viridian Forest south gate",
  51: "Viridian Forest", 54: "Pewter Gym", 56: "Pewter Poke Mart", 58: "Pewter Pokemon Center",
  64: "Cerulean Pokemon Center", 65: "Cerulean Gym", 67: "Cerulean Poke Mart", 68: "Mt. Moon Pokemon Center",
  81: "Rock Tunnel Pokemon Center", 89: "Vermilion Pokemon Center", 91: "Vermilion Poke Mart", 92: "Vermilion Gym",
  123: "Celadon department store, second floor", 133: "Celadon Pokemon Center", 134: "Celadon Gym",
  136: "Celadon department store, fifth floor", 141: "Lavender Pokemon Center", 150: "Lavender Poke Mart",
  152: "Fuchsia Poke Mart", 154: "Fuchsia Pokemon Center", 157: "Fuchsia Gym", 166: "Cinnabar Gym",
  171: "Cinnabar Pokemon Center", 172: "Cinnabar Poke Mart", 178: "Saffron Gym", 180: "Saffron Poke Mart", 182: "Saffron Pokemon Center",
};

/** Verified Gen I service map IDs; a map's presence does not verify an available service/script. */
export const pokemonServiceMaps = {
  shop: [42, 56, 67, 91, 123, 136, 150, 152, 172, 180],
  heal: [41, 58, 64, 68, 81, 89, 133, 141, 154, 171, 182],
} as const;

export function pokemonLocation(id: number): string {
  return locations[id] ?? (id >= 12 && id <= 36 ? `Route ${id - 11}` : `map ${id}`);
}
