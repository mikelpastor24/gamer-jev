import type { PokemonMoveData } from "./move-catalog.js";

const stats = ["Attack", "Defense", "Speed", "Special", "accuracy", "evasion"] as const;
const statRoles = ["Attack affects physical attacks, not special attacks.", "Defense protects against physical attacks, not special attacks.",
  "Speed affects turn order and escape attempts.", "Special affects both special attack damage and defense in Generation I.",
  "Accuracy affects whether a move hits.", "Evasion affects whether opposing moves hit."] as const;
const validStage = (value: number | undefined): value is number => value !== undefined && value >= 1 && value <= 13;

/** Evidence for pure stat changes and known unconditional failures; unknown effects remain attempts. */
export function pokemonMoveEffect(move: PokemonMoveData, playerStages: Uint8Array, enemyStages: Uint8Array,
  enemyStatus: number | undefined): { readonly detail: string; readonly failure?: string } {
  if (move.effect === 0x55 && move.power === 0) return { detail: "No battle effect.", failure: "This move has no battle effect." };
  if (move.effect === 8 && enemyStatus !== undefined && (enemyStatus & 7) === 0) return { detail: "Requires a sleeping target.", failure: "The target is not asleep; this move fails." };
  if (move.power !== 0) return { detail: "" };
  const up = move.effect >= 0x0a && move.effect <= 0x0f ? move.effect - 0x0a :
    move.effect >= 0x32 && move.effect <= 0x37 ? move.effect - 0x32 : undefined;
  const down = move.effect >= 0x12 && move.effect <= 0x17 ? move.effect - 0x12 :
    move.effect >= 0x3a && move.effect <= 0x3f ? move.effect - 0x3a : undefined;
  const index = up ?? down;
  if (index === undefined) return { detail: "" };
  const stage = (up === undefined ? enemyStages : playerStages)[index], name = stats[index]!;
  const detail = `${up === undefined ? "Enemy" : "User"} ${name} stage=${validStage(stage) ? `${stage - 7 >= 0 ? "+" : ""}${stage - 7}` : "unknown"} (range -6 to +6). No direct HP damage. ${statRoles[index]}`;
  if (up !== undefined && stage === 13 || down !== undefined && stage === 1) return { detail,
    failure: `${name} is already at its ${up === undefined ? "minimum -6" : "maximum +6"} stage; repeating this move cannot change it.` };
  return { detail };
}

export function pokemonStageSummary(player: Uint8Array, enemy: Uint8Array): string {
  const describe = (values: Uint8Array) => stats.map((name, index) => `${name}=${validStage(values[index]) ? values[index]! - 7 : "unknown"}`).join(", ");
  return `Live battle stat stages: user ${describe(player)}; enemy ${describe(enemy)}. Zero is the neutral decoded stage; unknown RAM is not proof of neutrality.`;
}
