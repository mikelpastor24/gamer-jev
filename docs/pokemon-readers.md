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
| `battleMove1` through `battleMove4` | Active normal-battle moves: name, type, Gen I category, power, approximate base accuracy, live PP, effect hints, and ordinary damage multipliers when applicable |
| `battleMenu`, `battleMoveSelection` | Confirmed command/move menu or unknown screen and highlighted move slot; action availability keys separately protect delayed responses |
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

### Battle move choices and types

[`PokemonBattleSupport`](../src/profiles/pokemon/battle-support.ts) reads the
165 move records, English move names, and type-effect table from the loaded
cartridge. Exact ROM offsets and menu/Disable RAM addresses live in
[`battle-layout.ts`](../src/profiles/pokemon/battle-layout.ts). These bounded,
immutable decoded tables are cached per reader and cleared on reset/restore.
No bundled move database, additional model, or vision key is needed.

Jev receives the active player's and enemy's types alongside each move. An
ordinary damaging move includes its physical/special category under Gen I
rules, same-type attack bonus (STAB), and combined effectiveness against the
enemy's distinct types: for example, `STAB=1.5x; effectiveness=4x`. Duplicate
type bytes count once. The cartridge table preserves Gen I behavior, including
Ghost attacks doing no damage to Psychic and Poison/Bug weaknesses; modern
type charts are not substituted. Unknown/invalid metadata stays unknown.

These factors are not predicted final damage. Stats, stages, critical hits,
burn, screens, random damage and detailed effects are not modeled. Base accuracy
is the approximate ROM threshold, not current hit probability. Status moves
include effect hints where decoded, with damage effectiveness marked `n/a`;
Growl is described as lowering Attack rather than as an immune Normal attack
against Ghost. Fixed damage, OHKO, copied/random moves and other special rules
are identified separately, without applying ordinary STAB/type factors as a
damage estimate. This information supports decisions without guaranteeing the
best move.

When the normal move menu's RAM anchors, displayed names and cursor agree,
the reader offers `use_move_1` through `use_move_4` for slots with PP that are
not disabled. Each choice carries its move facts. Its profile executor navigates
only to Jev's selected slot and sends one A confirmation pulse, within 600
frames. It stops if the menu closes or battle actors, moves, PP or Disable state
change. Cursor movement does not invalidate a chosen slot, while a delayed
generic A is protected against a changed highlight. Temporary index changes
during printing settle locally. UP/DOWN, B, wait and stop remain available;
A is excluded on a move without PP or a disabled move. Ineffective horizontal,
START and move-swapping SELECT inputs are excluded in this confirmed menu.
Demonstration, Safari, move-learning/Mimic prompts and unknown screens retain
their existing controller attempts. Party switching, items, and complete
battle-command legality are not implemented as semantic actions.

Inspect these fields and choices through **Game state** or the dashboard's
Jev request/response inspection, including when using direct TypeSafe without
vision. Jev chooses the attack; the reader never substitutes a stronger move.

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
map header, connection, and warp tables from the loaded ROM.
[`region-graph.ts`](../src/profiles/pokemon/region-graph.ts) reads tileset/block
and collision tables to split maps into separate walking areas. Warp squares
are endpoints, tile-pair barriers remain barriers, and ledges connect areas in
one direction. Connections use signed landing offsets; doors use their exact
zero-based destination warp, including outdoor-parent LAST_MAP returns. It
compares each offered exit's landing area with the current area's distance to
the active recognized milestone's map. Actions describe closer, farther, or
unknown routes. Grouped doorway entries with different landing distances remain
unknown. It never selects an exit or marks the milestone complete.

For example, Route 2's southern and northern areas share a map ID but have no
ordinary walking path between them. Returning south from Viridian Forest's
south gate must not be labeled a shortcut to Brock. The static regional graph
instead describes onward travel through the forest and its north gate.
Derived topology is bounded to 248 maps, 16,384 squares per map, 262,144 total
squares, 32,768 nodes, and 65,536 edges, with one cached objective-distance
table. Reset/restore clears it; raw navigation ROM caching remains at four banks.
Absent, invalid, oversized, or unreachable data remains unknown. Static terrain
does not model changing script gates, moving NPCs, Cut, Surf, Strength puzzles,
conveyors, or special warps. Local availability still uses fresh RAM, and no
coarse map-distance fallback claims that a disconnected area is reachable.
Known sprite IDs provide appearance labels such as Professor Oak
or Poke Ball; they do not prove an actor's current script or an object's contents.

Feedback retains up to 32 target/context records and the best observed local
distance. Repeating the same partial approach increments failed-attempt evidence,
even if it moves the player. A new shortest distance, map change, or observed
story check, bag item IDs, or party count change clears applicable repetition evidence. This is
navigation feedback, not verified story progress or a forced recovery choice.

[`travel-memory.ts`](../src/profiles/pokemon/travel-memory.ts) separately keeps
up to 32 settled map crossings, so long battles cannot erase navigation loops
from the short decision history. It identifies repeated immediate returns and
labels the exit back to the map this visit came from. Duplicate snapshots,
menus, ongoing movement, and transitions do not count as arrivals. New tracked
story checks, badges, bag contents, or party count clear this evidence, as do
objective edits and reset/restore. Battle HP, PP, and level changes alone do not
establish travel progress. Warnings stay bounded and retain all legal return
choices, including useful healing or backtracking trips.

The reference project's [region graph](https://github.com/christianmat/jev-pokemon/blob/main/src/game/regions.ts)
and [overworld decisions](https://github.com/christianmat/jev-pokemon/blob/main/src/agent/overworld.ts)
inspired these original adaptations. It also asks Jev for a persistent focus
such as progress or healing, tags repeated ineffective options, and sometimes
samples an alternative after repeated failure. This project currently adds
regional facts and crossing memory; it always executes Jev's selected action.
Persistent Jev-selected focus, service routing, and dynamic regional refinements
remain future work.

These are decoded mechanical facts, not universal legal-command guarantees.
Unknown or uninitialized collision data preserves directional attempts. Surfing
and unknown movement modes retain controls without asserting walking routes;
active Strength retains attempted boulder pushes. Scripts, locks, forced movement,
and other field mechanics may still reject a route. Appearance labels are not
verified script identities, and route distances do not prove quest progress.

Item IDs and party move IDs retain their raw values. Active normal-battle moves
add names and properties decoded from the cartridge as described above. No
bundled game-data table is used; a nickname need not identify its species.

Actions retain stable controller IDs such as `press_a` and `press_down`, with
context descriptions. Button presses use at most eight frames, or a shorter
`--action-frames` setting, followed by four release frames. Waits retain the
configured duration. Simultaneous button combinations are excluded. LCD-off
and blocked overworld transitions offer only `wait` and `stop`. Stable overworld
and known menu/text phases use the additional availability rules above. Unknown
menus and battle screens outside the confirmed move menu retain single-button attempts: a control can do nothing if the
current screen ignores it. The reader does not claim to enumerate every legal in-game command
or exclude every ineffective input. Jev selects every offered gameplay action.
The optional executors implement only the selected destination or move slot;
they do not choose battle moves, new destinations, or a walkthrough on the
model's behalf.

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
`progress.ts` interprets supplied story checkpoints, `map-graph.ts` decodes map
metadata, `region-graph.ts` supplies static regional distance facts,
`travel-memory.ts` retains map crossings, and `navigation-execution.ts` retains
a selected destination;
`navigation-layout.ts` supplies verified RAM and ROM addresses for its mechanics.
`battle-support.ts` decodes move/type facts and menu availability;
`battle-execution.ts` retains the selected attack slot, and `battle-layout.ts`
supplies exact cartridge and battle-menu addresses.
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
Battle support caches at most 165 move descriptions and a bounded type table.

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
- [Move record properties](https://github.com/pret/pokered/blob/d2704a63c26f9ba046ade877445216b3de0519a4/data/moves/moves.asm)
- [Generation I type-effect table](https://github.com/pret/pokered/blob/d2704a63c26f9ba046ade877445216b3de0519a4/data/types/type_matchups.asm)
- [Move effects](https://github.com/pret/pokered/blob/d2704a63c26f9ba046ade877445216b3de0519a4/constants/move_effect_constants.asm)
- [Red/Blue battle menus, type damage and STAB](https://github.com/pret/pokered/blob/d2704a63c26f9ba046ade877445216b3de0519a4/engine/battle/core.asm)
- [Yellow battle menus and rules](https://github.com/pret/pokeyellow/blob/e89ead154b9968aa50eed9328ff2b38b6c194382/engine/battle/core.asm)
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
Battle tests also use invented ROM tables/names and cover dual types, immunities,
STAB, status/special rules, PP/Disable exclusions, stale contexts, printing,
selected-slot execution, and frame ceilings. Local read-only checks decoded move
properties and type factors from all three cartridges. An isolated Red replay
recognized the actual normal move menu and executed slot 2 (Growl): its PP fell
from 40 to 39, Scratch's PP stayed unchanged, and the enemy's Attack fell. It
used an offline fixture decider, made no API requests, and did not overwrite the
user's checkpoint. These checks validate mechanics rather than Jev's strategy.
Synthetic regional tests cover disconnected areas, exact gate landings, signed
connection offsets, warp endpoints, directed ledges, unknown tables, and repeated
crossings across battle snapshots for all three readers. A read-only local
cartridge check found the same south forest gate distances in Red, Blue, and
Yellow: eight static area transitions from the gate to Pewter Gym, seven after
entering the forest, and ten after returning to southern Route 2. An isolated
Red checkpoint replay confirmed that a chosen route still stops for a wild
battle; it did not establish an uninterrupted trip through the forest.
Full-game
play and live Jev performance have not been verified. Yellow-specific follower
behavior and Pikachu's happiness are not decoded by the shared reader.

These readers supply observations and local wayfinding, not a complete Pokémon
agent. Dynamic region-aware routing, gate/script prerequisites, full battle-command
legality, full field mechanics, and verified full-objective completion remain
future work. Static regional distance and named story checks do not fill those gaps.
Vision can supplement missing visible evidence.
Loading the ROM and decoding state do not establish that Jev will finish it.
