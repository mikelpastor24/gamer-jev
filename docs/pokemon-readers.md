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
records follow the workflows in [Agent sessions](agent-sessions.md#objectives-and-limits).

## What Jev receives

| Fields | Meaning |
| --- | --- |
| `phase`, `gameStarted` | Boot/intro, transition, boxed text, menu, naming, overworld, or battle evidence |
| `screenTextTop`, `screenTextBottom` | English text decoded from complete boxes in the 20 by 18 work-RAM tile map |
| `dialogueActive`, `dialogueSession` | Live overworld dialogue evidence and a local episode ID, independent of partially printing text |
| `lastDialogueLocation`, `lastDialogueText`, `lastDialogueStateChanged`, `lastDialogueHere`, `completedDialoguesHere` | Bounded observation memory of completed conversations, their recent text, tracked changes, and text/visits from the current position/facing |
| `menuCursorX`, `menuCursorY`, `menuCursorRow` | Visible boxed cursor position and its row; not a claim that the game is polling input |
| `menuKind`, `menuSelection`, `menuSelectionEffect` | Identified overworld START menu, highlighted entry, and the empty-party confirmation restriction when applicable |
| `namingPrompt`, `enteredName`, `namingKind` | Player/rival/Pokemon naming heading, verified buffer and screen type when the alphabet grid is visible |
| `partyMenuKind`, `partySelection` | Verified party list/switch/medicine context and highlighted row, independent of duplicate nicknames |
| `playerName`, `rivalName` | Terminated, decoded names after gameplay starts |
| `mapId`, `playerX`, `playerY`, `mapWidth`, `mapHeight`, `facing`, `movementMode` | Location and movement state; map dimensions use movement squares |
| `locationName`, `navigationStatus`, `movementInProgress`, `controlBusy`, `stepUP/DOWN/LEFT/RIGHT` | Known location names, live movement/control timing, and walking/turning/blocked/unknown evidence |
| `currentFocus`, `focusStatus` | Jev's persistent purpose and whether a fresh purpose choice is required during settled exploration after receiving the Pokedex |
| `partyHealth`, `preparationNeeds`, `upcomingChallenge` | Overworld preparation advice: per-member HP percentage, low attack PP/status, backup/supply needs, and the next recognized uncompleted leader's cartridge team |
| `standingExit`, `exitTriggerInputs` | Warp underfoot and decoded outward inputs for facing-edge exits; an applicable step is marked `exit_trigger` |
| `money`, `badgeCount`, `badges`, `pokedexOwned`, `pokedexSeen` | Packed-BCD money, badge flags, and 151-species bit counts |
| `bagCount`, `bagItems`, `pokeBalls` | Occupied bag slots, internal item ID/quantity pairs and total ordinary capture balls; names and quantities appear in bounded decision facts |
| `partyCount`, `party1` through `party6`, corresponding `Moves` fields | Nicknames, internal species IDs, levels, big-endian HP, types, status, and move IDs/PP |
| `battleKind`, `battleType`, `battlePlayer`, `battlePlayerMoves`, `battleEnemy` | Active battle data, including current HP and normal/demo/Safari variant |
| `battleMove1` through `battleMove4` | Active normal-battle moves: name, type, Gen I category, power, approximate base accuracy, live PP, effect hints, and ordinary damage multipliers when applicable |
| `battleMenu`, `battleMoveSelection` | Confirmed commands/moves, printing moves, fainting transition, text acknowledgment or unknown screen, and highlighted move slot; action availability keys separately protect delayed responses |
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

Party move fields include ROM names, types, ordinary base power or status/special
classification and current/max PP, including the Generation I PP Up bonus.
Names are clipped to 12 characters to keep all four slots bounded. A zero status
byte means `no status condition`; it does not mean HP and PP are full.
Party and battle structures are different. During a fight, `battlePlayer`
contains current HP and `battlePlayerMoves` contains current PP; the party copy
can lag until the fight ends. Internal species IDs are **not Pokédex numbers**.

### Preparation, healing and building a team

[`PokemonPreparationSupport`](../src/profiles/pokemon/preparation-support.ts)
is an adjunct to the memory reader, independent of Jev and vision. It adds reasons
to purpose choices and bounded facts to observations. It prioritizes
a Center at 50% HP or less for any member, for fainted/status-affected members, or when a known
ordinary attack has at most a quarter of its maximum PP. A below-30% HP band,
status or low-PP change prompts a fresh purpose choice; thresholds are advice,
not restrictions on the user's objective or legal inputs. Full recovery requires
known full HP, cleared status and full PP. Unknown data never prove recovery.

A completed battle followed by a settled, valid injured party requests a fresh
purpose choice, even if HP remains in the same band. A current healing purpose
persists; other purposes also offer a direct `focus_heal` switch when a known
Center route exists. Duplicate reads and transitional party data do not consume
the post-battle review. Priority facts appear before general context and in action
descriptions. Supplied constraints remain authoritative and Jev selects healing,
destinations and the nurse interaction; no service is performed automatically.

[`preparation-catalog.ts`](../src/profiles/pokemon/preparation-catalog.ts) reads
fixed-width species names, national-dex mappings, base-stat types, trainer party
records and land encounters from the supplied ROM using
[`preparation-layout.ts`](../src/profiles/pokemon/preparation-layout.ts).
Cache bounds are 190 species, 248 maps with ten encounter slots each, and
16 trainer-party results with at most six members each. Reset/restore clears
these decoded tables. [`move-catalog.ts`](../src/profiles/pokemon/move-catalog.ts)
shares the existing bounded 165 moves and type chart with battle support.
ROM assets/bytes are never sent to Jev or recorded.

For an active recognized supplied gym milestone, preparation reports the
uncompleted leader's actual cartridge team, levels/types and the best known
usable ordinary attack type factor against each member. The first four Elite
Four teams are also decoded when their recognized milestone map applies.
The final Champion's starter-dependent team, custom objectives, enemy learned
moves, full damage prediction and guaranteed readiness remain unknown.
Status/special moves are excluded from ordinary damage comparisons. Suggestions
of useful potential attack types require a known chart and party moves;
species typing alone does not prove that a capture learns those attacks.

Capture purpose is offered from cities when a known reachable encounter area,
capacity and balls or affordable Mart supplies exist. With no balls, its first
stage labels routes toward a Mart and its clerk. Item, quantity and price remain
separate Jev choices. Inventory-only changes preserve this capture purpose and
refresh stage distances; story/team/owned-Pokedex and urgent preparation changes
still request reconsideration. With balls, candidate encounter maps favor species
absent from the current team and use the same exact walking areas
and landings. At most four coarse candidates and one distance table are used;
grassless indoor encounters, Red/Blue versus Yellow half-block rules and water
shores are distinguished. Ordinary routing excludes Safari and unverified Tower
encounters. Repel, scripts, HM access and moving objects can still prevent a route
or encounter. Jev chooses each destination, encounter square, target and ball.

Each verified eligible wild species absent from the team receives an explicit
capture priority, including species already owned in the Pokedex and species
sharing the team's types. `open_capture_bag`, individual ball choices and usable
attack actions explain that priority and the risk of knocking out the target.
Duplicates remain legal capture choices. Unknown team identity never proves
absence; trainer, ghost, fainting and capacity exclusions still apply. Missing
balls prioritize affordable, storable Mart ball choices, with quantity and price
confirmation left to separate decisions. An attempted throw never proves success.

The reference project's [decision context](https://github.com/christianmat/jev-pokemon/blob/main/src/agent/context.ts)
and [overworld choices](https://github.com/christianmat/jev-pokemon/blob/main/src/agent/overworld.ts)
inspired this preparation vocabulary. This implementation keeps game knowledge
inside the profile and does not sample substitute actions or restore checkpoints.
Synthetic tests cover injury, PP Ups, recovery, unknown data, exact cartridge
layouts, capture prerequisites, purpose persistence and disconnected encounter
areas. Read-only metadata checks verified leader/encounter tables for the three
local cartridges. An isolated Red checkpoint replay restored HP and all four
move PP at the Pewter Center with fixture choices, no API calls and no save writes.
These checks do not establish live Jev healing/capture strategy or full-game competence.

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

These factors are not predicted final damage. Stat stages are decoded separately;
stats, critical hits,
burn, screens, random damage and detailed effects are not modeled. Base accuracy
is the approximate ROM threshold, not current hit probability. Status moves
include effect hints where decoded, with damage effectiveness marked `n/a`;
Growl is described as lowering Attack rather than as an immune Normal attack
against Ghost. Fixed damage, OHKO, copied/random moves and other special rules
are identified separately, without applying ordinary STAB/type factors as a
damage estimate. This information supports decisions without guaranteeing the
best move.

[`battle-effects.ts`](../src/profiles/pokemon/battle-effects.ts) reads evidence
for pure stat changes from the exact six live stage bytes per actor. RAM values
1-13 mean stages -6 to +6; invalid values stay unknown. It explains that Attack
and Defense affect physical moves, while Generation I Special affects both
special offense and defense. A pure boost at +6 or reduction at -6 cannot apply
again. Known Splash, Dream Eater against a known awake target and ordinary
damaging type immunity also receive explicit failure facts. If another known
usable move exists, that failed slot and generic A on its highlight are withheld.
With no decoded alternative, bounded attempts remain. Unknown effects and special
damage rules do not inherit ordinary immunity exclusions. No alternate move is
selected by the reader. This is not complete battle legality or damage prediction.

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
their existing controller attempts. Verified party selection, switch confirmation,
capture, medicines and Mart choices are described below. Complete switching and
battle-command legality remain partial.

Known usable `use_move_N` choices are also offered at a verified normal FIGHT
command screen. Their executor opens FIGHT, settles within 120 frames, validates
the actual move list and executes only Jev's selected slot within its 600-frame
ceiling. Normal living wild battles offer `run_from_wild`: it returns from a move
list if necessary, selects RUN and confirms once, with no retry or substituted
attack. Trainers, unusual battles and changed actor contexts do not acquire that
action. An escape attempt is not evidence that escape succeeded.

The reader supplies a bounded `decisionSupport.decisionGoal` for the current
screen, which the shared Jev question considers before distant milestones.
Without verified capture eligibility or balls, the current battle task is to
resolve it with a usable damaging move or escape attempt; capture preparation is
a later task. Capture candidates and attack warnings about avoiding a knockout
are supplied only when capture is currently available. An eligible wild species
absent from the team instead gets a cautious weakening or bag/ball task based on
live HP and attack risk. Buy lists, quantity
prompts and shop confirmations carry their own tasks without automatically
buying anything. Selected healing/supply purposes persist through dialogue,
while actor identity and observed recovery still need evidence.

An isolated saved Red battle verified a fixture-selected attack from FIGHT
consumed exactly one PP and reduced enemy HP. Another fixture replay reached
the -6 Attack cap after six effective Growl uses and verified its exclusion.
Both used zero API calls and preserved the original checkpoint. These are
mechanical replay checks, not live Jev strategy validation.

A separate copied Red checkpoint replay bought one ball at Viridian Mart,
entered Route 1 under a fixture-selected capture purpose and executed one
selected ball throw, observing its inventory consumption. The target was not
captured. It used zero API requests and preserved the original save; it verifies
purchase/throw mechanics and task continuity, not Jev strategy or capture success.

Text, menu and naming A/B confirmations use one frame so the backend's per-frame
input events cannot close and immediately reopen a dialogue or confirm both
quantity and price before another decision. Move, item and command cursor pulses
end as soon as the selected slot/coordinate is observed, avoiding overshoot when
each frame repeats a direction. Four runner release frames still follow actions;
unknown controller attempts retain their bounded configured durations.

Inspect these fields and choices through **Game state** or the dashboard's
Jev request/response inspection, including when using direct TypeSafe without
vision. Jev chooses the attack; the reader never substitutes a stronger move.

### Fainting and battle text

[`PokemonBattleFlow`](../src/profiles/pokemon/battle-flow.ts) distinguishes
fainting transitions from text prompts in normal battles. With a decoded
active Pokemon at 0 HP and no visible choice or verified text continuation,
`battleMenu: faint_pending` requests neutral settling. The runner skips both
Jev and vision for at most 600 frames, retaining cancellation and session
limits. If readiness remains unknown at that ceiling, controller attempts
remain available for Jev to reassess. Stale move names with a fainted actor
do not establish a printing move menu.

A complete bottom dialogue box with a continuation arrow and no selection
cursor/grid becomes `battleMenu: text_acknowledgment`. Its facts explain that
the game needs A or B; more neutral waiting will not advance that prompt.
Only A, B and stop are offered. Jev still selects the acknowledgment, with a
single input frame followed by the normal release, before observing again.
No local code presses a button automatically. The reader retains one bounded
prompt fingerprint across arrow blinking, invalidates it when the text,
actors or screen changes, and clears it on reset/restore. A delayed
acknowledgment cannot silently acquire the next message's meaning.

Party selection, YES/NO prompts, naming grids and unknown choice screens
remain Jev decisions. Fainting facts explain that a 0-HP actor cannot attack,
that a defeated wild enemy cannot be captured, and that a fainted enemy does
not prove the whole battle is over. Replacement-party controls and other
battle variants are still only partially decoded. Synthetic tests cover all
three readers, provider skipping, cancellation, the frame ceiling and one
chosen acknowledgment. An isolated Red checkpoint replay verified that
600 neutral frames leave the fainted message open and one fixture-selected
A reaches the experience message, with no API requests or changes to the
original checkpoint. This does not establish live Jev behavior or complete
fainting/switching mechanics.

Normal dialogue without a verified continuation/choice also uses `text_pending`;
uninitialized actors with no visible choice use `actors_pending`. Both settle
locally for at most 600 neutral frames, skipping Jev and vision, then preserve
unknown controller attempts if no input marker arrives. Text readiness and
private prompt identity survive an actor's initialization. Partially printed
verified move lists settle before accepting a confirmation. Every completed
continuation still needs a Jev-selected A/B; no text or answer is chosen locally.

### Capture, inventory and visible loot

[`PokemonItemSupport`](../src/profiles/pokemon/item-support.ts) adds inventory,
capture and preparation evidence without another model call. Its catalog reads
at most 83 item names and prices from the user's cartridge; exact ROM offsets
and RAM menu/storage addresses are in
[`item-layout.ts`](../src/profiles/pokemon/item-layout.ts). Reset/restore clears
the bounded catalog and menu snapshot. Observations contain decoded facts,
never cartridge bytes.

Jev receives ordinary ball counts, named inventory slots, party size and
storage limits, enemy HP/status and the live catch-rate threshold. That
threshold is not a success percentage. Facts explain that defeating a wild
target prevents capture and that lower HP and supported status conditions can
help. Known enemy types absent from the party identify potential coverage;
coverage and party size do not establish gym readiness. Trainer, demonstration,
Safari, fainted/transitional and unverified ghost encounters have no ordinary
capture actions. Full parties require space in the current PC box; a stored
capture does not immediately join the party.

[`PokemonCaptureSupport`](../src/profiles/pokemon/capture-support.ts) derives a
fresh capture task from that eligibility, available balls and the active moves.
In Gen I, the HP benefit saturates near one third for Poke/Ultra Balls and one
half for Great Balls. It applies the game's integer rounding to find each ball's
actual plateau, including small HP totals; it never insists on 25% or 1 HP.
Ball descriptions expose approximate per-throw probability from live HP, status
and the catch-rate threshold, conditional on an eligible normal encounter and
uniform random values. These are not guarantees or the raw catch-rate byte
expressed as a percentage. Great Balls can outperform Ultra Balls at high HP.
Master Balls ignore HP but remain scarce, separately selected resources.

Above those plateaus, known usable single-turn ordinary attacks can supply
approximate HP damage and critical-hit upper estimates using current attack/
defense or Gen I Special, STAB and the cartridge's distinct-type factors.
Normal live stats already include stages/burn/badge effects; do not apply them
twice. Critical estimates use matching unmodified party/wild stats and doubled
level, bypassing screens and stat changes. Unknown stats/chart/actor identity,
special damage, multi-hit, charging, trapping, recoil, self-KO and residual-damage
effects do not establish a cautious attack. Estimates omit intermediate type
rounding and future enemy actions and are not a guaranteed damage calculator.

Jev is asked to choose one cautious weakening move and inspect fresh HP afterward.
It is asked to throw when a ball's HP benefit is already maximized, another attack
could KO, no cautious estimate is established, the active Pokemon is at 30% HP or
less, or poison/burn/seed/confusion puts the target at risk. This can accept 30-40%
or higher HP rather than lose a desired capture. Sleep/freeze improve captures
more than other statuses; poison/burn add a risk of defeating the target.
If the bag is opened while cautious weakening is still recommended, the task
explains B returns to commands before Jev selects a move. Early throws and all
otherwise legal moves remain available; no attack or throw is automatic. Live
HP/stat/status and preparation-meaning changes invalidate delayed action choices.

Synthetic fixtures cover all three readers: high HP, rounded plateaus, gentle
versus KO-risk attacks, PP/Disable, normal versus critical stats, Special/STAB/
distinct types, unknown data, status risk and bag tasks. A read-only copied Red
battle produced Scratch HP-risk advice and a 7/15 Poke Ball plateau with one
hypothetical ball supplied only to the advice helper. It used no inventory edits,
emulator advancement, API calls or original save writes. This validates decoded
advice, not a capture attempt or live Jev strategy.

In a confirmed normal wild battle, `open_capture_bag` opens ITEM and stops.
Jev then chooses `throw_ball_slot_N` from a verified bag menu. Each action
uses exactly one selected Master/Ultra/Great/Poke Ball, with one confirmation
frame. Safari balls are excluded from these choices. The executor never
chooses another ball, weakens the target automatically, or retries a throw.
Changed actors, HP/status, inventory, capacity or menus end the action;
ignored controls and all execution remain bounded to 600 frames. Generic A
uses the highlighted item and is protected against changed inventory or
selection. Nickname grids take precedence over a lingering battle flag.

The navigation adjunct distinguishes visible pickups using cartridge object
flags and item IDs, matched to live visible sprites. Their existing
`interact_object_N` choices say **pick up**, name the item when available and
warn when a new bag slot is needed. A ball-shaped starter sprite is not
classified as loot. Hidden items are not enumerated. An interaction attempts
collection; inventory/object changes provide evidence of its result.

### Buying supplies and preparing the team

A verified Mart BUY list offers `choose_shop_item_slot_N` for items with
known prices and at least one affordable/storable unit. These choices select
the item and stop at the quantity prompt. Jev chooses UP/DOWN, accepts the
quantity, and separately confirms the displayed total price with YES.
Cursorless quantity boxes are recognized from their RAM and displayed value;
ordinary dialogue does not acquire quantity controls. Selecting an item never
automatically purchases it. Selling, deposits and most other item uses retain
generic controller choices.

### Distinct names and party selection

[`PokemonNamingSupport`](../src/profiles/pokemon/naming-support.ts) recognizes
Pokemon nickname grids as well as player/rival naming. It validates the live
buffer, length and cursor, even when the cursor crosses the alphabet's first row.
`name_option_1..4` offer whole names, rather than asking Jev to repeatedly select
individual letters. The executor replaces the entry with exactly the chosen name,
confirms each key once and submits START once, within 600 frames. Changed context,
ignored text edits or cancellation stop it without another name. A partial entry
can be continued through another Jev-selected action. Player/rival names have a
seven-character limit; Pokemon names have ten. Offered names use uppercase letters.

Pokemon suggestions avoid case-insensitive duplicates in the known party,
current box (at most 20 names), and up to 32 recently observed names. Reads never
rename existing Pokemon. Unseen boxes remain unknown. Reset/restore clears private
name memory and rereads live names; objective edits refresh suggestions.
Add a standalone line to **Settings → Agent → Objectives**, in constraints or
milestones, to supply a pool of preferred names:

```text
Pokemon names: EMBER, WING, LEAF, NOVA
```

Up to 16 distinct suggestions of 1-10 A-Z letters are retained, with the first
four unused choices offered. Already reserved/invalid names are skipped;
cartridge-heading names with bounded letter suffixes supply alternatives.
The directive suggests choices; it does not execute naming or verify a story
milestone. Supplied constraints remain authoritative.

[`PokemonPartySupport`](../src/profiles/pokemon/party-support.ts) recognizes
unboxed party rows using matching nickname positions, RAM menu type, cursor and
valid member data. Slot/species/level/HP identify a member even when every nickname
is identical. A verified normal battle party list offers `select_party_slot_N`
for different living members, excluding the active or fainted member and generic
A on those rows. A voluntary choice opens SWITCH/STATS/CANCEL; Jev separately
selects `confirm_switch_to_slot_N`. Replacement/between-opponent choices can send
the selected member directly. `open_party_menu` opens POKEMON from commands/moves
without selecting a member. Voluntary choices explain B can cancel to retain a
stronger active member; forced replacement asks for a living alternative. Verified
party choices withhold ineffective waiting and obey the live B-key mask.
A visible replacement list is not faint settling.
Outside battle, party selection opens that member's normal menu. Reordering,
HMs, unknown variants and full switching legality remain incomplete.

### Buying and applying medicine

Mart choices recommend small affordable/storable reserves of around two
HP-restoring items and two Antidotes, considering injuries/status, existing stock
and money needed for balls. Quantity prompts explain reserve deficits; Jev still
chooses quantity and confirms total price separately. Sufficient stock removes
the reserve priority. Known useful supplies also appear in shopping-purpose
advice; a full bag can retain purchases into a known non-full existing stack.

`open_medicine_bag` opens ITEM from battle commands/moves, or START → ITEM outside
battle, and stops at the bag. `choose_medicine_slot_N` selects a known beneficial
Antidote/Potion/Super Potion/Hyper Potion/Max Potion/Full Restore. Outside battle,
Jev separately chooses USE in the verified USE/TOSS menu. A verified medicine
party list offers `apply_medicine_to_slot_N` only where the selected item has a
known benefit. Jev chooses the exact slot; the executor confirms it once and
never substitutes a member or consumes another item automatically.

Potions restore bounded missing HP; Antidotes cure poison without restoring HP.
Full Restore additionally cures decoded nonvolatile status. These actions do not
restore PP or revive fainted members. Matching live battle HP/status override
lagging party data for advice. Poison/status or 30%-or-less active HP can prioritize
medicine in battle; outside battle, status or 50%-or-less HP prioritizes a useful
medicine already held. Centers remain relevant for fuller recovery.

Medicine targeting validates the saved bag cursor plus scroll, complete bounded
inventory, stock, item-list pointer, ordinary item context and live party rows.
The party renderer reuses `wListMenuID` as HP-bar type 2, `wCurItem` as species,
and `wStringBuffer` as SGB packet data. These fields cannot be interpreted as
the previous bag's item ID/name or list ID. The verified saved bag row instead
identifies the selected item, including when restoring directly into its party
selector. `partyMedicine` exposes that item's name, bag slot and current quantity.
Unknown item identity retains bounded
controller attempts and a cancellation explanation. Every step stays within
600 frames; changed inventory, party, HP/status or menu meaning ends execution
or invalidates a delayed response. Verify inventory consumption and HP/status
afterward; opening a menu or selecting an item is not healing.

Known medicine selectors that are still drawing or printing expose
`medicine_pending` and settle locally for at most 600 neutral frames. Complete
party rows, cursor and the finished English target prompt release settling;
Jev still chooses the recipient. Cancellation explicitly means no recovery,
and a medicine without any beneficial recipient offers cancellation rather
than another ineffective treatment. Pending rendering, aliases, changed stock
or pointers, and scrolled bag selections are covered for Red, Blue and Yellow.

The saved Red healing loop repeated bag selection and cancellation while the
active Pokemon stayed at 7/24 HP. An isolated replay of that checkpoint selected
its existing Potion and then party slot 1, observing 24/24 HP and one consumed
Potion with two offline fixture choices, zero API requests and no writes to the
original save. This verifies treatment mechanics and decoder advice, not live
Jev adherence or general battle strategy. The reference project's battle-item
flow likewise waits for the target selector and checks inventory consumption.

Synthetic Red/Blue/Yellow checks cover duplicate names, configured names, cursor
movement, forced/voluntary switching, fainting, stale responses, medicine effects,
stock/price limits, separate quantity confirmation and unknown item identity.
An offline session selects an Antidote, USE and slot 2 separately, observing one
consumed item and cleared poison with zero HTTP requests. This does not establish
live Jev name choice, shopping strategy or full-game competence.

A copied Red checkpoint with two Pokemon named `AAAAAAAAAA` reached a wild battle
under explicit offline fixture inputs. The fixture selected `open_party_menu`,
party slot 2 and the separate SWITCH confirmation, observing the active species
change from Charmeleon (slot 1) to Pidgey (slot 2). Fourteen fixture actions used
zero API requests and preserved the original save. This verifies slot targeting
with duplicate names, not whether switching to that member is a good strategy.

When capture balls are missing in the early region, local exit facts also
identify directions that lead closer to Viridian/Pewter Mart using static
walking areas and exact landing warps. These supply facts remain separate
from the story milestone. They neither select a detour nor prove that a
shop/script is currently accessible. Money, bag space and shop prerequisites
still matter. Default constraints prioritize healing at 50% HP or less after
battles, nearby verified loot, and eligible wild species absent from the team;
custom constraints remain authoritative. Reader facts supply these priorities
even with existing objectives, without rewriting any user edits.
Existing edited objectives are preserved. To adopt the new suggestions, use
**Settings → Agent → Objectives → Use game defaults**, review and apply.

The reference's [battle decisions](https://github.com/christianmat/jev-pokemon/blob/main/src/agent/battle.ts)
and [overworld decisions](https://github.com/christianmat/jev-pokemon/blob/main/src/agent/overworld.ts)
informed this original implementation. Capture estimates follow the verified
[Red/Blue capture routine](https://github.com/pret/pokered/blob/master/engine/items/item_effects.asm#L170-L303)
and [Yellow routine](https://github.com/pret/pokeyellow/blob/master/engine/items/item_effects.asm#L182-L316),
with HP risk informed by the [Gen I damage routine](https://github.com/pret/pokered/blob/master/engine/battle/core.asm#L3921-L4032).
Persistent focus remains independently selected by Jev. These additions
make opportunities explicit; live Jev team-building competence is unverified.

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

Standing on a verified automatic stair landing does not reactivate its warp.
The ineffective zero-distance exit action is withheld there. Up to four explicit
`step_off_exit_*` choices walk to a validated adjacent non-warp square and stop;
Jev must select the original exit again to return. No executor chooses a recovery
direction or walks back automatically. Return options match a persistent purpose
only when the original stair's exact landing route is known to be closer;
arrival stairs leading away are not marked as priority returns. Unknown and
special warp mechanics retain bounded controller attempts. A copied Red
Mt. Moon checkpoint stepped off and re-entered its selected stair into the prior
floor with offline fixture decisions, no API calls and no save writes; the next
onward healing exit was distinguished from returning to that arrival stair.

A bounded breadth-first search supplies distances and all equally short first
controller inputs to exits and interaction positions. Other warp squares are
terminal to avoid claiming a path can walk through an exit without changing maps.
Jev can choose a controller input or a semantic destination action. Up to 20
destinations are offered, prioritizing nearby pickups, useful stair returns,
the selected purpose, the active supplied milestone and then local distance:
`go_exit_*`, `go_boundary_*`,
`interact_object_*`, and `interact_sign_*`. A profile executor retains the chosen
target, reads fresh routes, emits bounded movement pulses, waits for walking,
faces an interaction target, and sends A once. It stops for dialogue, battle,
menu/script interruption, map change, loss of reachability, 120 frames without
movement, or its 600-frame ceiling. Four release frames follow. It cannot
substitute a different destination or restore a checkpoint. Jev chooses again
after interruption or completion. View this evidence in **Jev exchange → Input → Game facts &
routes**, or in the complete Game state/API snapshot. Action descriptions also
include concise facts; action records include `executionReason`.

Verified live item balls at up to eight walking steps from an interaction square
receive a pickup priority before routine travel, independently of story purpose.
Urgent healing comes first. At most eight nearby pickup/stair actions stay
selectable during a fresh purpose choice. Ordinary NPCs, starter balls,
hidden/mismatched sprites, unknown inventory capacity and known full bags or
99-item stacks do not receive a collectible priority. More distant pickups remain
opportunities under normal navigation. Only observed inventory/object changes
confirm collection. These bounded priorities do not guarantee that live Jev
will follow them or complete a game.

A long non-pickup navigation action stops when a new verified collectible enters
that nearby range after walking settles, so Jev receives a fresh choice before
the route passes it. The executor never picks the item or changes destinations.
Items already nearby when Jev chose the route do not force repeated stops;
another item also does not interrupt a selected pickup. Navigation keys include
the nearby item set, refreshing a late response if those opportunities changed.

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

[`focus.ts`](../src/profiles/pokemon/focus.ts) adds a separate purpose decision
after the Pokedex is received and a party exists. In settled exploration with
no current purpose, Jev chooses `focus_progress`, `focus_explore`, or a supported
shopping, healing, training or capture purpose. These input-free profile actions
store Jev's choice; they never choose a destination or send controller input.
Map changes and incidental battles retain that purpose. `reconsider_focus`
lets Jev explicitly request a new purpose. User objectives and constraints
remain in every decision; a preparation purpose does not replace the story goal.

Known Mart/Center maps use the same exact walking-area and landing geometry.
At most four service candidates are considered per query, with at most eight
candidate IDs retained for the current map and one retained distance table.

The bounded service catalog is ranked by distance from the current exact walking
area before keeping four candidates for each kind. Single-goal queries score
the catalog and the final query uses at most four targets; only one distance
table is retained. Moving to another walking area refreshes the shortlist, even
within the same map. Four coarse nearby shops in disconnected areas must not
hide a reachable fifth shop. Static access still does not verify current stock,
shop prerequisites or scripts.
Arriving at the destination is separate from completing its task: clerk/nurse
interactions match the selected service purpose, while the exit back outside
is labelled as leaving it. Trainer-class names come from bounded cartridge
metadata (47 names, at most 24 bytes each) and matching live sprites. A trainer
name in the recognized milestone can mark a relevant interaction, including
Brock; this does not establish battle readiness, defeated status, or trainer
identity for changed script contexts. Training/capture purposes can use regional
land-encounter guidance as described above. Up to four local encounter-square
targets are offered and only the selected square is walked to. Arrival does not
guarantee an encounter or capture. Unavailable/special service scripts remain unknown.

Purpose outcomes retain at most 64 map/action attempt counts, six historical
best route distances, and six purpose selection counts. A new best distance
can be useful navigation evidence; returning to a previously reached distance,
crossing the same doorway again, or toggling menus is not a new best. After
six completed actions without such improvement, settled exploration requires
another Jev purpose choice; every purpose also receives a 32-action review.
Repeated choices and their outcomes remain visible across these reviews. Reads
do not consume either interval. Cancelled actions, purpose selections and battle
actions do not increment navigation attempts. Training level gains count only
for training; ordinary HP/PP/level changes do not prove story/navigation progress.
Tracked story checks, badges, owned species, team changes, fainting and preparation
health/PP bands invalidate focus. Bag changes refresh a selected capture purpose's
stage; other purposes reconsider them. Observed known full HP/status/PP recovery
reconsiders healing. Objective edits and
reset/restore clear this session-local memory; checkpoints do not persist it.

The reference project's [region graph](https://github.com/christianmat/jev-pokemon/blob/main/src/game/regions.ts)
and [overworld decisions](https://github.com/christianmat/jev-pokemon/blob/main/src/agent/overworld.ts)
inspired these original adaptations, including persistent purpose and repeated
attempt evidence. It also sometimes samples an alternative or restores a
checkpoint after failure. This project executes only Jev's offered selection.
Dynamic regional refinements and full-game competence remain future work;
reconsideration cannot guarantee the model will never repeat an unhelpful choice.

Synthetic tests cover purpose selection, map/battle persistence, retained best
distances, repeat reviews, evidence invalidation, grass arrival and actual action
feedback. Read-only checks on the three local cartridges verified Brock's
decoded name and the Pewter service map headers. An isolated copy of the latest Red checkpoint reached the Pewter
Mart's priced list with fixture choices and approached the selected Brock
target until an intermediate trainer script opened dialogue. The original
checkpoint was preserved and no APIs were used. This validates local options
and mechanical execution, not live Jev strategy or completing either task.

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
The optional executors implement only the selected destination, move or item slot;
they do not choose battle moves, new destinations, or a walkthrough on the
model's behalf.

### Editable story objectives

All three readers supply default objectives in
[`objectives.ts`](../src/profiles/pokemon/objectives.ts): become League Champion,
six constraints about exploration, preparation, capture, supplies, names and medicines, and 16 story
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
`travel-memory.ts` retains map crossings, `focus.ts` retains Jev's purpose and
bounded completed-action outcomes, and `navigation-execution.ts` retains
a selected destination;
`navigation-layout.ts` supplies verified RAM and ROM addresses for its mechanics.
`battle-support.ts` decodes move/type facts and menu availability;
`battle-execution.ts` retains the selected attack slot, and `battle-layout.ts`
supplies exact cartridge and battle-menu addresses.
`item-support.ts` supplies capture/inventory/Mart facts and choices;
`capture-support.ts` supplies rounded ball HP plateaus, capture estimates and
bounded ordinary/critical attack-risk advice without selecting an input;
`naming-support.ts` and `naming-execution.ts` offer unique whole-name choices and
type only the selected name; `party-support.ts` validates slot-based party choices
and medicine recipients; `medicine.ts` supplies bounded member/medicine effects;
`item-catalog.ts` caches bounded decoded names/prices, `item-layout.ts` supplies
revision addresses, and `item-execution.ts` follows only the selected menu target.
`preparation-support.ts` supplies team/health/challenge advice and capture stages;
`preparation-catalog.ts` and `preparation-layout.ts` decode revision-specific
species, leader parties and encounters. `move-catalog.ts` shares move/type
metadata with battle support; `encounter-tiles.ts` describes land encounter tiles.
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
- [Item list and quantity menus](https://github.com/pret/pokered/blob/d2704a63c26f9ba046ade877445216b3de0519a4/home/list_menu.asm)
- [Party input and aliased item/species fields](https://github.com/pret/pokered/blob/master/home/pokemon.asm)
- [Party drawing and target prompts](https://github.com/pret/pokered/blob/master/engine/menus/party_menu.asm)
- [Reference medicine targeting and consumption checks](https://github.com/christianmat/jev-pokemon/blob/main/src/agent/battle.ts)
- [Mart selection and purchase confirmation](https://github.com/pret/pokered/blob/d2704a63c26f9ba046ade877445216b3de0519a4/engine/events/pokemart.asm)
- [Capture restrictions and ball effects](https://github.com/pret/pokered/blob/d2704a63c26f9ba046ade877445216b3de0519a4/engine/items/item_effects.asm)
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

Item tests use invented names, prices, RAM and menus for all three readers.
They cover inventory bounds, capture exclusions, selected-slot execution,
stale highlights/inventory, quantity prompts, shop identity changes, visible
pickup flags and hidden/mismatched sprites. A mock session verifies that capture
facts and choices reach the Jev request and only the selected ball executes,
with a final release and no HTTP attempts. Local read-only checks matched
Poke Ball/Potion names and prices and the three visible forest pickups in each
cartridge. An isolated Red replay followed fixture-selected routes to Viridian
Mart, selected a shop item, purchased one ball and threw that selected ball at
a wild Pidgey. The ball was consumed without catching the target. It made no
provider requests and preserved the original checkpoint. This establishes
menu/execution mechanics, not live Jev capture strategy.

These readers supply observations and local wayfinding, not a complete Pokémon
agent. Dynamic region-aware routing, gate/script prerequisites, full battle-command
legality, full field mechanics, and verified full-objective completion remain
future work. Static regional distance and named story checks do not fill those gaps.
Vision can supplement missing visible evidence.
Loading the ROM and decoding state do not establish that Jev will finish it.
