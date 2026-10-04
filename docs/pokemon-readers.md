# Pokémon game readers

The shipped strategies support these exact English **USA, Europe** releases.
Red and Blue are SGB Enhanced; Yellow is **Special Pikachu Edition**, with
GBC and SGB enhancements. Yellow runs in Game Boy mode with this adapter;
these reader checks do not establish general Game Boy Color support.

| Reader | SHA-256 | SHA-1 |
| --- | --- | --- |
| `pokemon-red-en` | `5ca7ba01642a3b27b0cc0b5349b52792795b62d3ed977e98a09390659af96b7b` | `ea9bcae617fdf159b045185467ae58b2e4a48b9a` |
| `pokemon-blue-en` | `2a951313c2640e8c2cb21f25d1db019ae6245d9c7121f754fa61afd7bee6452d` | `d7037c83e1ae5b39bde3c30787637ba1d4c48ce2` |
| `pokemon-yellow-en` | `8cbaa499397e4f1a679c992ea9382a2dd7942ab398b48c19829c2d9529de47bf` | `cc7d03262ebfaf2f06772c1a480c7d9d5f4a38e1` |

The registry detects the reader from the console and SHA-256. Renaming the file
does not change compatibility. Translations, hacks, patched ROMs, and different
revisions need their own verified descriptors and layouts. This repository
includes no commercial ROM, artwork, extracted font, or game-data dump.

## Run a supported release

Supply your own ROM. These examples use short filenames; use your actual
local path, including quotes when it contains spaces. All three readers are
selected automatically, including in manual mode.

The local viewer can also switch among these cartridges in **Settings → ROMs**.
Add your files directly to `roms/`, choose one, and press **Load selected ROM**.
It saves the previous game's checkpoint and starts the selected ROM in pause
with its reader. To continue a saved game, use **Settings → Session → Restore
checkpoint** and then **Resume**. Applied goals and session settings carry over;
each game starts with fresh agent counters and history.

```sh
# Manual play and local memory inspection; no credentials or model calls.
npm start -- --rom "roms/pokemon-red.gb"

# Offline integration check; mock choices do not understand Pokémon.
npm start -- --rom "roms/pokemon-red.gb" --agent mock --vision none --goal "Inspect the opening menus" --headless --decisions 10

# Jev through direct TypeSafe, with local memory observations and no vision.
npm start -- --rom "roms/pokemon-red.gb" --agent typesafe --vision none --goal "Choose a starter Pokemon and explore Pallet Town"
npm start -- --rom "roms/pokemon-blue.gb" --agent typesafe --vision none --goal "Choose a starter Pokemon and explore Pallet Town"
npm start -- --rom "roms/pokemon-yellow.gb" --agent typesafe --vision none --goal "Receive Pikachu and explore Pallet Town"
```

For direct Jev, set `TYPESAFE_API_KEY` in your local `.env`. Gateway decisions
use `--agent gateway` and `AI_GATEWAY_API_KEY`. To add visual evidence, select
`--vision gateway` independently and supply the Gateway key and optional
`VISION_MODEL`. An existing reader continues to provide memory facts and
actions when vision is enabled. No screenshots leave the computer with
`--vision none`.

Open **Game state** in the viewer to inspect facts, descriptions, and
available actions. The same snapshot is available at `GET /api/game-state`.
Use `--profile pokemon-red-en`, `--profile pokemon-blue-en`, or
`--profile pokemon-yellow-en` to select explicitly. A mismatched profile is
rejected even for Red and Blue, which share RAM addresses. Use `--list-profiles`
to list readers, and `--load <checkpoint>` to resume a compatible local checkpoint.
Pause or stop from the viewer; Ctrl+C stops the process. Agent limits and
records follow the workflows in the [README](../README.md).

## What Jev receives

| Fields | Meaning |
| --- | --- |
| `phase`, `gameStarted` | Boot/intro, transition, boxed text, menu, naming, overworld, or battle evidence |
| `screenTextTop`, `screenTextBottom` | English text decoded from complete boxes in the 20 by 18 work-RAM tile map |
| `dialogueActive`, `dialogueSession` | Live overworld dialogue evidence and a local episode ID, independent of partially printing text |
| `lastDialogueLocation`, `lastDialogueText`, `lastDialogueStateChanged`, `lastDialogueHere`, `completedDialoguesHere` | Bounded observation memory of completed conversations, their recent text, tracked changes, and text/visits from the current position/facing |
| `menuCursorX`, `menuCursorY`, `menuCursorRow` | Visible boxed cursor position and its row; not a claim that the game is polling input |
| `menuKind`, `menuSelection`, `menuSelectionEffect` | Identified overworld START menu, highlighted entry, and the empty-party confirmation restriction when applicable |
| `namingPrompt`, `enteredName` | Player/rival naming heading and current entry when the naming alphabet grid is visible |
| `playerName`, `rivalName` | Terminated, decoded names after gameplay starts |
| `mapId`, `playerX`, `playerY`, `mapWidth`, `mapHeight`, `facing`, `movementMode` | Location and movement state; map dimensions use movement squares |
| `locationName`, `navigationStatus`, `movementInProgress`, `controlBusy`, `stepUP/DOWN/LEFT/RIGHT` | Known location names, live movement/control timing, and walking/turning/blocked/unknown evidence |
| `standingExit`, `exitTriggerInputs` | Warp underfoot and decoded outward inputs for facing-edge exits; an applicable step is marked `exit_trigger` |
| `money`, `badgeCount`, `badges`, `pokedexOwned`, `pokedexSeen` | Packed-BCD money, badge flags, and 151-species bit counts |
| `bagCount`, `bagItems` | Occupied bag slots and internal item ID/quantity pairs |
| `partyCount`, `party1` through `party6`, corresponding `Moves` fields | Nicknames, internal species IDs, levels, big-endian HP, types, status, and move IDs/PP |
| `battleKind`, `battleType`, `battlePlayer`, `battlePlayerMoves`, `battleEnemy` | Active battle data, including current HP and normal/demo/Safari variant |
| `oakEncounterCompleted`, `starterReceived`, `firstRivalBattleCompleted`, `parcelReceived`, `pokedexReceived` | Named opening event-flag evidence |
| `activeMilestone`, `activeMilestoneGoal`, `objectiveMapId`, `completedStoryChecks` | First pending recognized supplied checkpoint in the user's list order, its target map, and satisfied checkpoint IDs |

Fields appear only when applicable. Before the game timer starts and a valid
player name exists, the reader excludes party, location, and progression
defaults written during Oak's introduction. It drops active battle fields
when the battle flag clears, regardless of stale enemy bytes remaining in RAM.
Invalid counts, names, BCD, and transitional Pokémon data stay unknown or
unavailable; they are not coerced into plausible game facts.

The reader interprets text-box borders before decoding text. Map graphics and
portraits can reuse character tile IDs; decoding every tile as a letter would
invent text. Text can be incomplete while printing, and each text field is
limited to 256 characters. Unboxed content is excluded, except for the naming
heading and entry when its alphabet grid establishes the context. This is
memory decoding, not OCR or a vision model. Battle graphics, some status and
party screens, and other unboxed labels are not fully represented.

Party and battle structures are different. During a fight, `battlePlayer`
contains current HP and `battlePlayerMoves` contains current PP; the party copy
can lag until the fight ends. Internal species IDs are **not Pokédex numbers**.

When the complete START menu is visible and POKEMON is selected with an empty
party, the reader excludes A: that selection cannot open the party screen.
Other entries and unrelated menus retain their confirmation controls. The reader exposes this restriction as memory-derived
state, and describes START as menu access rather than obtaining a starter.
Jev also receives the shared runtime's action results and recurring-state
feedback. Those observations can reveal a menu loop or an input that left
coordinates unchanged; they do not establish a collision map or verified progress.

### Profile-owned decision support

[`GenerationOneDecisionSupport`](../src/profiles/pokemon/decision-support.ts) is
an adjacent class used by the reader. It enriches decoded state with bounded
`decisionSupport.facts` and `actionFacts` for the current choices. Jev and optional
vision use the same profile output; no extra provider or key is required.

Its adjacent [`PokemonInteractionMemory`](../src/profiles/pokemon/interaction-memory.ts)
retains the last completed conversation and up to 32 interaction locations,
identified by map, position, and facing. Active dialogue requires the complete
bottom text box and the overworld font flag. A conversation finishes when the
reader observes a return to the overworld; menus and transitions do not count
as completion. Repeated inspection of the same state does not add visits.
Each dialogue retains at most eight recent text fragments, with its exposed
summary capped at 256 characters. This memory outlasts the short action history
and is cleared by reader reset/restore or session history reset; it is not saved
inside emulator checkpoints.

The support class compares decoded party, inventory, money, badges, Pokedex,
names, and the 320-byte event-flag array between observed dialogue start and end.
Raw event flags stay local. These are partial observed changes, not verified
quest progress. If the latest conversation at the current position/facing made
no tracked change and that tracked state still matches, Jev receives a warning:
A starts another interaction rather than advancing the completed conversation.
Its recent text remains available to inform the next destination. A stays
available: healing, rewards, changing actors, and untracked mechanics can make
another interaction useful. Changes in tracked state suppress the stale warning.

During walking or cycling, it reads live padded map blocks, tileset pointers,
warp destinations, connected-map strips, signs, sprite positions, and hidden
object flags. It decodes block tiles, passable tiles, tile-pair collisions, and
one-way ledges from the user's loaded ROM. Red/Blue collision lists are in the
fixed ROM bank; Yellow uses bank 1, independently of the graphics/block bank.
All addresses are revision-specific in
[`navigation-layout.ts`](../src/profiles/pokemon/navigation-layout.ts).
Only immutable ROM slices are cached, up to four banks; reset and restore clear
them and the bounded map graph. Live objects, routes, and action availability
are recalculated every read.

The reader distinguishes a passable step from facing an obstacle without moving.
After facing a confirmed obstacle, that walking input is excluded. A remains
available for interacting with decoded objects, signs, counters, and scenery.
Standing on a warp retains directional attempts because some exits trigger on
a collision or an additional input. A live walking counter offers only wait/stop
until the current movement completes. The runner settles that animation locally
without a model call. It also settles ignored overworld controls and transitions,
including 60 neutral frames after a detected map change, with a 600-frame ceiling
before obtaining a fresh decision. B/SELECT are excluded during exploration;
the complete START menu offers vertical navigation, confirmation, and closing.
Text boxes offer A/B, waits, and stopping. Naming and unrelated menus retain
their applicable attempts.

Adjacent warp entries to the same destination are grouped as one doorway for
route distances. This prevents two squares of the same exit mat from appearing
as competing destinations. For facing-edge warps, the reader exposes the outward
direction explicitly: on the player's ground-floor exit mats, DOWN activates
the exit to Pallet Town. Moving LEFT/RIGHT between those mats stays inside.
An initial short press can turn first; the destination executor repeats the
same outward direction, or Jev can select another bounded controller input.
The outward input stays available even when its neighboring square lies beyond
the map boundary. The automatic-warp tile lists are read from revision-specific
ROM pointers, so stairs/door tiles are not described as requiring an edge push.
Special-map and tileset rules that use different warp checks remain unknown;
scripts can still delay or reject a transition. Reaching an exit coordinate
alone is not proof that the destination was reached.

A bounded breadth-first search supplies distances and all equally short first
controller inputs to exits and interaction positions. Other warp squares are
terminal to avoid claiming a path can walk through an exit without changing maps.
Jev can choose a controller input or a semantic destination action. Up to 20
destinations are offered, prioritizing candidates related to the active supplied
milestone and then local distance: `go_exit_*`, `go_boundary_*`,
`interact_object_*`, and `interact_sign_*`. A profile executor retains the chosen
target, reads fresh routes, emits bounded movement pulses, waits for walking,
faces an interaction target, and sends A once. It stops for dialogue, battle,
menu/script interruption, map change, loss of reachability, 120 frames without
movement, or its 600-frame ceiling. Four release frames follow. It cannot
substitute a different destination or restore a checkpoint. Jev chooses again
after interruption or completion. View this evidence in **Jev exchange → Input → Game facts &
routes**, or in the complete Game state/API snapshot. Action descriptions also
include concise facts; action records include `executionReason`.

[`map-graph.ts`](../src/profiles/pokemon/map-graph.ts) reads revision-specific
map header, connection, and warp tables from the loaded ROM. This supplies
coarse map distances to the current story destination. Outdoor-parent return
edges are inferred only for maps with a LAST_MAP warp; sealed maps get no
invented return. An exit that decreases this distance is described as a
candidate toward the milestone. The graph does not prove regional reachability,
unlock a gate, implement special mechanics, or guarantee the shortest playable
story route. Known sprite IDs provide appearance labels such as Professor Oak
or Poke Ball; they do not prove an actor's current script or an object's contents.

Feedback retains up to 32 target/context records and the best observed local
distance. Repeating the same partial approach increments failed-attempt evidence,
even if it moves the player. A new shortest distance, map change, or observed
story check, bag item IDs, or party count change clears applicable repetition evidence. This is
navigation feedback, not verified story progress or a forced recovery choice.

These are decoded mechanical facts, not universal legal-command guarantees.
Unknown or uninitialized collision data preserves directional attempts. Surfing
and unknown movement modes retain controls without asserting walking routes;
active Strength retains attempted boulder pushes. Scripts, locks, forced movement,
and other field mechanics may still reject a route. Appearance labels are not
verified script identities, and route distances do not prove quest progress.

Item and move IDs are not translated using a bundled game-data table. Names
visible in boxed menus remain available as text; a nickname need not identify
its species.

Actions retain stable controller IDs such as `press_a` and `press_down`, with
context descriptions. Button presses use at most eight frames, or a shorter
`--action-frames` setting, followed by four release frames. Waits retain the
configured duration. Simultaneous button combinations are excluded. LCD-off
and blocked overworld transitions offer only `wait` and `stop`. Stable overworld
and known menu/text phases use the additional availability rules above. Unknown
menus and battles retain single-button attempts: a control can do nothing if the
current screen ignores it. The reader does not claim to enumerate every legal in-game command
or exclude every ineffective input. Jev selects every offered gameplay action.
The optional executor implements only the selected target; it does not choose
battle moves, new destinations, or a walkthrough on the model's behalf.

### Editable story objectives

All three readers supply default objectives in
[`objectives.ts`](../src/profiles/pokemon/objectives.ts): become League Champion,
two constraints about useful exploration and preparation, and 16 story
milestones from leaving the house through the League. Yellow's starter guidance
describes receiving Pikachu rather than choosing a Red/Blue starter.
These suggestions load automatically for a fresh ROM in manual or agent mode.
Edit them in **Settings → Agent → Objectives**, or copy them back with **Use game
defaults** and then **Apply changes**. Explicit CLI objectives and custom UI
objectives take precedence. Default suggestions refresh across ROM changes;
custom objectives and session ceilings are preserved.

[`progress.ts`](../src/profiles/pokemon/progress.ts) matches exact supplied
default milestone strings in the user's supplied order and reports the first pending checkpoint as
`activeMilestone`, `activeMilestoneGoal`, and `objectiveMapId`. Removing or
rewriting a milestone removes its interpretation; a custom goal and constraints
remain authoritative. These fields guide Jev and never select an action.

The opening evidence uses named event bits from the verified revision layouts:

| Story check | Memory evidence |
| --- | --- |
| Meet Oak | `EVENT_FOLLOWED_OAK_INTO_LAB`, bit 0 |
| Receive starter | `EVENT_GOT_STARTER`, bit 34 |
| First rival battle | `EVENT_BATTLED_RIVAL_IN_OAKS_LAB`, bit 35 |
| Collect parcel | `EVENT_GOT_OAKS_PARCEL`, bit 57 |
| Obtain Pokedex | `EVENT_GOT_POKEDEX`, bit 37 |

Later checks combine badges with named Bill, HM, Rocket, Fuji, Silph, and League
events. The hideout checkpoint also requires an observed Silph Scope in the full
bag, or the later Flute event; defeating its boss alone does not collect the
item. Lavender's checkpoint is explicitly an observed settled arrival during
this session, or the later Flute event, without claiming the player learned
everything in the guidance. Combined milestones retain prerequisite destinations
until the relevant checks are satisfied.

`completedStoryChecks` lists satisfied checkpoint IDs. These criteria do not
verify every instruction in the milestone prose, team preparation, alternate
paths, arbitrary custom text, or the full user objective. Visiting Oak's lab
without his encounter flag does not complete the opening check. In Pallet Town,
the reader explains the Route 1 encounter trigger: row 1 in Red/Blue, row 0 in
Yellow. Later-game checks use synthetic tests and documented constants; full-game
play has not been validated. Jev's stop action remains unverified completion.

Pressed actions also carry a bounded semantic `availabilityKey` derived from
phase, map, overworld position/facing, visible menu/naming context, and dialogue
episode when applicable. Printing another fragment within one dialogue does
not change its key. If the dialogue closes while Jev responds, its A choice
cannot execute as a new overworld interaction. The runtime records the changed
context, discards that response, and obtains a fresh decision without pausing.

## Share code by engine family

A single memory layout cannot read every Pokémon game. The reusable part is
an observation vocabulary and decoding for a compatible engine:

```text
GameReader contract
  GenerationOnePokemonReader (English Gen I structures and encoding)
    pokemon-red-en (exact hash and shared Red/Blue layout)
    pokemon-blue-en (exact hash and shared Red/Blue layout)
    pokemon-yellow-en (exact hash and Yellow layout)
  future Gen II reader (its engine structures and encoding)
  future GBA reader (its engine structures and a GBA emulator adapter)
```

[`generation-one.ts`](../src/profiles/pokemon/generation-one.ts) owns Gen I
decoding and action descriptions. [`encoding.ts`](../src/profiles/pokemon/encoding.ts)
owns English character codes, BCD, bit counts, and boxed text.
`decision-support.ts` owns profile-specific facts and local navigation;
`progress.ts` interprets supplied story checkpoints, `map-graph.ts` owns coarse
connectivity, and `navigation-execution.ts` retains a selected destination;
`navigation-layout.ts` supplies verified RAM and ROM addresses for its mechanics.
[`red.ts`](../src/profiles/pokemon/red.ts),
[`blue.ts`](../src/profiles/pokemon/blue.ts), and
[`yellow.ts`](../src/profiles/pokemon/yellow.ts) supply each exact revision.
Red and Blue use [`red-blue-layout.ts`](../src/profiles/pokemon/red-blue-layout.ts);
Yellow supplies its own explicitly checked addresses. Do not apply a uniform
offset to all Red addresses: Yellow's tile-map and sprite fields retain their
addresses while many later fields move. These modules stay under `src/profiles/`;
the core, Jev adapters, vision adapters, and runner contain no Pokémon knowledge.
Reads take a fresh
bounded RAM snapshot without writes, frame advancement, or RAM caches.
Navigation additionally caches bounded immutable ROM slices, never live RAM.

To add a compatible Gen I release:

1. Verify the user's exact ROM hash against an authoritative disassembly.
2. Check every `GenerationOneLayout` address and the character/structure
   assumptions for that language and revision. If semantics differ, extend or
   specialize the family reader rather than changing addresses blindly.
3. Create a descriptor and factory using `GenerationOnePokemonReader`, and
   register them in `src/profiles/default-registry.ts`.
4. Add synthetic RAM tests for the differences. Check the reader locally with
   a legally obtained ROM through startup, menus, overworld, party, and battle.
   Keep that ROM and all resulting saves/screenshots out of Git.

Later generations need different readers; a common filename, franchise, or
English title does not establish RAM compatibility. GBA games such as Emerald
also require an emulator backend that this project does not currently supply.

## Evidence and limits

Release identities and layout facts were checked against the matching
English disassemblies:

- [Red/Blue release hashes](https://github.com/pret/pokered)
- [Yellow release hash](https://github.com/pret/pokeyellow)
- [Red symbol addresses](https://github.com/pret/pokered/blob/3f618d59edf43918f48f5e558c34e04cb2fc5619/pokered.sym)
- [Blue symbol addresses](https://github.com/pret/pokered/blob/3f618d59edf43918f48f5e558c34e04cb2fc5619/pokeblue.sym)
- [Yellow symbol addresses](https://github.com/pret/pokeyellow/blob/573535d742a347c6b20ab74f962df4c9820a0bbb/pokeyellow.sym)
- [Red/Blue work-RAM structures](https://github.com/pret/pokered/blob/d2704a63c26f9ba046ade877445216b3de0519a4/ram/wram.asm)
- [Yellow work-RAM structures](https://github.com/pret/pokeyellow/blob/e89ead154b9968aa50eed9328ff2b38b6c194382/ram/wram.asm)
- [Character encoding](https://github.com/pret/pokered/blob/master/constants/charmap.asm)
- [Party structures and PP masks](https://github.com/pret/pokered/blob/master/constants/pokemon_data_constants.asm)
- [Runtime flags](https://github.com/pret/pokered/blob/master/constants/ram_constants.asm)
- [Red/Blue walking, tile pairs, and warp triggers](https://github.com/pret/pokered/blob/d2704a63c26f9ba046ade877445216b3de0519a4/home/overworld.asm)
- [Yellow walking and collision-bank differences](https://github.com/pret/pokeyellow/blob/e89ead154b9968aa50eed9328ff2b38b6c194382/home/overworld.asm)
- [Directional ledge rules](https://github.com/pret/pokered/blob/d2704a63c26f9ba046ade877445216b3de0519a4/engine/overworld/ledges.asm)
- [Facing-edge and automatic warp checks](https://github.com/pret/pokered/blob/master/engine/overworld/player_state.asm)
- [Reference exit handling](https://github.com/christianmat/jev-pokemon/blob/main/src/agent/overworld.ts)
- [Reference story milestones](https://github.com/christianmat/jev-pokemon/blob/main/src/knowledge/milestones.ts)
- [Red/Blue named event bits](https://github.com/pret/pokered/blob/d2704a63c26f9ba046ade877445216b3de0519a4/constants/event_constants.asm)
- [Yellow named event bits](https://github.com/pret/pokeyellow/blob/e89ead154b9968aa50eed9328ff2b38b6c194382/constants/event_constants.asm)
- [Key item IDs](https://github.com/pret/pokered/blob/d2704a63c26f9ba046ade877445216b3de0519a4/constants/item_constants.asm)
- [Red/Blue Pallet encounter script](https://github.com/pret/pokered/blob/d2704a63c26f9ba046ade877445216b3de0519a4/scripts/PalletTown.asm)
- [Yellow Pallet encounter script](https://github.com/pret/pokeyellow/blob/e89ead154b9968aa50eed9328ff2b38b6c194382/scripts/PalletTown.asm)
- [Reference project's state, legal options, and facts architecture](https://github.com/christianmat/jev-pokemon/tree/20cdcb846ff995383fe3da1d48ad5eac6d8d1abd)

The reader is an original implementation using documented layout facts; no
disassembly code or commercial assets are copied. Automated tests use invented
RAM and blank frames for each release, including party/battle decoding, startup
guards, bounded actions, cross-version rejection, restore/reset, and memory-only
sessions. Local checks with the matching ROMs exercised startup, intro, naming,
the repeated Red mother dialogue and its delayed-input context change,
the starting room, overworld menus, restore/reset, and memory-only decision
execution. Additional isolated local checks matched blocked and passable directions
and followed decoded exit routes from both house floors into Pallet Town in all
three revisions. A later isolated replay used an offline fixture decision
provider selecting the offered destination actions: all three reached Oak's
encounter and laboratory, with the correct event flag and the starter checkpoint
active. Red began from a copy of the user's Pallet checkpoint; Blue and Yellow
began on the upper house floor. No API calls were made and the original saves
were unchanged. These checks validate mechanics, not Jev's live choices.
Party/battle decoding is covered by synthetic fixtures; full-game
play and live Jev performance have not been verified. Yellow-specific follower
behavior and Pikachu's happiness are not decoded by the shared reader.

These readers supply observations and local wayfinding, not a complete Pokémon
agent. Complete region-aware routing, gate/script prerequisites, battle-command
legality, full field mechanics, and verified full-objective completion remain
future work. Coarse connectivity and named story checks do not fill those gaps.
Vision can supplement missing visible evidence.
Loading the ROM and decoding state do not establish that Jev will finish it.
