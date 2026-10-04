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
  51: "Viridian Forest", 54: "Pewter Gym", 58: "Pewter Pokemon Center",
};

export function pokemonLocation(id: number): string {
  return locations[id] ?? (id >= 12 && id <= 36 ? `Route ${id - 11}` : `map ${id}`);
}
