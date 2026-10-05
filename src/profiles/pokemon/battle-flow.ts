import { createHash } from "node:crypto";
import type { StateValue } from "../../core/agent.js";
import { readTextScreen } from "./encoding.js";

interface BattleFlow {
  readonly menu: "text_acknowledgment" | "faint_pending" | undefined;
  readonly context: string | undefined;
  readonly facts: readonly string[];
  readonly actionFacts: Readonly<Record<string, readonly string[]>>;
}

/** Distinguishes neutral fainting transitions from text and selectable prompts. Never emits input. */
export class PokemonBattleFlow {
  private continuation: string | undefined;

  reset(): void { this.continuation = undefined; }

  read(tiles: Uint8Array, state: Readonly<Record<string, StateValue>>, actors: string): BattleFlow {
    const screen = readTextScreen(tiles);
    const playerFainted = String(state.battlePlayer).includes("HP=0/");
    const enemyFainted = String(state.battleEnemy).includes("HP=0/");
    // Unboxed/hollow cursors and alphabet grids also indicate choices; never silently advance those screens.
    const choice = screen.cursor !== undefined || tiles.includes(0xec) || tiles.includes(0xed) || /A B C D E F G H I/.test(`${screen.top}\n${screen.bottom}`);
    const dialogue = screen.dialogueBox && !choice && Boolean(screen.bottom);
    const normalized = tiles.slice();
    normalized[16 * 20 + 18] = 0x7f; // The continuation arrow blinks without changing the pending input.
    const key = createHash("sha256").update(actors).update(normalized).digest("hex").slice(0, 24);
    const arrow = dialogue && tiles[16 * 20 + 18] === 0xee;
    const acknowledged = dialogue && (arrow || this.continuation === key);
    this.continuation = acknowledged ? key : undefined;

    const facts: string[] = [], actionFacts: Record<string, string[]> = {};
    if (enemyFainted) facts.push("The active enemy has 0 HP and has fainted. It cannot be attacked or captured now. Resolve battle messages before expecting another command, enemy, or the overworld; this alone does not prove the whole battle is over.");
    if (playerFainted) facts.push("Your active Pokemon has 0 HP and cannot attack. Acknowledge any battle messages first. If a party or YES/NO prompt appears, Jev must choose whether/how to continue using the displayed choices and party HP; party HP can lag behind the active battle HP.");
    if (acknowledged) {
      facts.unshift("The complete battle dialogue has a text continuation prompt, with no visible selection cursor. It is waiting for A or B, not more time. Neutral wait and directional/menu inputs cannot advance this prompt. Acknowledging it does not select a move, replacement Pokemon, or YES/NO answer.");
      actionFacts.press_a = ["A advances the current battle message once. Waiting will leave this text prompt open; reassess the next screen before making a gameplay choice."];
      actionFacts.press_b = ["B also advances this text continuation prompt; here it acknowledges text rather than choosing NO or leaving battle."];
    } else if (choice && (playerFainted || enemyFainted)) {
      facts.push("A selection cursor or naming grid is visible after fainting. This is a choice screen, not a neutral animation: inspect its text, move the cursor if needed, and confirm the intended option. Do not wait for the game to choose a replacement Pokemon or YES/NO answer.");
    }
    // A missing/blinking arrow must not become an endless model-selected wait loop. The runner caps settling at 600 frames.
    const pending = (playerFainted || enemyFainted) && !choice && !acknowledged;
    if (pending) facts.push("Fainting or battle text may still be animating/printing. Settle locally with buttons released, up to the runner's frame ceiling. Without a verified continuation marker, input readiness remains unknown; waiting is not evidence of progress.");
    return { menu: acknowledged ? "text_acknowledgment" : pending ? "faint_pending" : undefined,
      context: acknowledged ? key : undefined, facts, actionFacts };
  }
}
