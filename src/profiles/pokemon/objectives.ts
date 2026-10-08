import type { Objectives } from "../../core/agent.js";

/** Editable story guidance. Checkpoint evidence is interpreted separately by the profile. */
export function pokemonObjectives(starter: "choice" | "pikachu"): Objectives {
  return {
    goal: "Become the Pokemon League Champion by defeating the Elite Four and the Champion.",
    constraints: [
      "Use dialogue and observed game state to decide the next useful destination. Complete necessary story prerequisites before attempting later milestones.",
      "After every battle, check every party member. If any has 50% HP or less, is fainted or has a status condition, or ordinary attack PP is low, prioritize a Pokemon Center before onward travel or optional fights. Interact with its nurse and inspect HP, status and PP afterward; arrival or opening START is not healing. Repeated menus, conversations and pacing do not advance the story.",
      "Attempt eligible wild species absent from the team, even if owned or sharing types. Obtain missing balls. Weaken cautiously toward the Gen I HP plateau (~33% Poke/Ultra, ~50% Great; rounding varies), reassessing after each move. Throw sooner if another attack risks a KO; do not chase 1 HP. Select each move and ball explicitly. Respect eligibility, storage and supplied constraints. Heal/train new members; review challenge levels/types and usable attacks before gyms.",
      "Prioritize reachable nearby verified item balls before routine travel when bag space permits; ordinary NPCs and starter balls are not loot. Urgent healing comes first. Verify the pickup through inventory or object changes. Check money, HP, levels and move PP before continuing; prepare instead of repeatedly attempting an unprepared gym.",
      "Give Pokemon distinct, meaningful nicknames using offered whole-name choices; do not repeatedly enter the same letter. Identify members by party slot, species and HP even when an existing save has duplicate names. Respect user-supplied nickname suggestions and constraints.",
      "When affordable and storable, keep a small reserve of two HP-restoring medicines and two Antidotes without exhausting money needed for balls. Antidotes cure poison; Potions restore HP. Use suitable medicines on explicitly selected party slots during urgent battles or after a battle when needed, then verify HP/status and inventory. Medicines do not replace Center recovery for PP or fainted members. Choose each purchase quantity and price confirmation separately.",
    ],
    milestones: [
      "Leave the player's house: use the stairs from the upper floor, reach a ground-floor exit mat, and press toward the outside. Walk north from Pallet Town toward Route 1 to meet Professor Oak.",
      starter === "choice" ? "At Oak's laboratory, choose a starter Pokemon from the table and complete the conversation." :
        "Follow Oak to his laboratory and receive Pikachu. Yellow does not offer the Red/Blue starter selection.",
      "Complete the first rival battle in Oak's laboratory and leave when the game permits.",
      "Travel north through Route 1 to Viridian City and visit the Poke Mart to collect Oak's Parcel.",
      "Return the parcel to Oak's laboratory in Pallet Town and obtain the Pokedex.",
      "Continue through Route 2 and Viridian Forest to Pewter City; prepare a team that can defeat Brock for the Boulder Badge.",
      "Cross Route 3 and Mt. Moon to Cerulean City, meet Bill, and earn Misty's Cascade Badge.",
      "Visit Vermilion City and the S.S. Anne to obtain Cut; earn Lt. Surge's Thunder Badge.",
      "Reach Lavender Town through Rock Tunnel and learn what is needed to explore Pokemon Tower.",
      "Visit Celadon City, defeat Team Rocket in the hideout for the Silph Scope, and earn Erika's Rainbow Badge.",
      "Use the Silph Scope in Pokemon Tower, help Mr. Fuji, and obtain the Poke Flute to pass sleeping Snorlax.",
      "Reach Fuchsia City; obtain Surf and the Gold Teeth in the Safari Zone, obtain Strength from the Warden, and earn Koga's Soul Badge.",
      "Help liberate Silph Co. in Saffron City and earn Sabrina's Marsh Badge.",
      "Reach Cinnabar Island, find the Secret Key in the Pokemon Mansion, and earn Blaine's Volcano Badge.",
      "Return to Viridian City and defeat Giovanni for the Earth Badge; confirm that all eight badges are owned.",
      "Prepare for Victory Road and the Pokemon League, then defeat the Elite Four and Champion. Treat completion as unverified unless supported by observed game evidence.",
    ],
  };
}
