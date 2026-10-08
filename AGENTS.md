# Repository Guidelines

## Purpose

Build a public repository where TypeSafe AI's Jev plays emulated Game Boy games.
The intended user experience is to supply a locally owned ROM, objectives, and
the credentials for a supported Jev provider, then start a gameplay session.
Make adding another game possible without changing the shared runtime.

The inspiration is [jev-pokemon](https://github.com/christianmat/jev-pokemon).
Its game-specific memory interpretation demonstrates one approach to supplying
useful state to Jev. This project must keep such knowledge outside its core.

## Language

- Write all repository content in English: documentation, code identifiers,
  comments, docstrings, tests, configuration examples, CLI messages, logs,
  commit messages, and pull request descriptions.
- Preserve proper names and external API identifiers when necessary.
- Conversation with the maintainer may remain in Spanish. Repository artifacts
  must remain in English unless the maintainer explicitly changes this rule.

## Current State

The first emulation milestone uses strict TypeScript, Node.js 22.18+, and the
pinned `serverboy` 0.0.7 backend. It includes a console registry, Game Boy adapter,
bounded headless runner, local manual viewer with stereo audio, PNG captures,
and save states. Audio is an optional `AudioSource` capability. Keep its queues
bounded and clear pending playback on pause, reset, restore, and tab hiding.
Jev decisions in `src/jev/` are independent of optional vision in `src/vision/`.
Decisions can use direct TypeSafe, Vercel AI Gateway, or mock; vision independently
uses Gateway, mock, or is disabled. They share bounded JSON transport and a request
budget in `src/providers/`. Provider factories read only their own settings. Observation
composition lives in `src/observation/`. A deterministic mock
works offline. Objectives, configurable session limits, recent history, JSONL records,
viewer inspection, and headless agent execution are implemented. Game readers
use the Strategy contract in `src/core/game-reader.ts`, a ROM-aware registry,
and TypeScript or declarative JSON implementations in `src/profiles/`. The
original demo has a verified memory reader. `src/profiles/pokemon/` separates
shared English Gen I decoding from exact Pokémon Red, Blue, and Yellow ROM hashes.
Red/Blue share a verified layout; Yellow has its own addresses. Startup, naming,
the starting room, and overworld menus were checked locally for all three;
party/battle decoding uses synthetic RAM tests. Other Pokémon revisions and
generations, complete field mechanics, full-game competence, and verified
full-objective completion remain future work. Named story checkpoints and
coarse map connectivity are implemented below, with narrower evidence.

Readers can return bounded optional `decisionSupport` facts and per-action facts.
The Pokemon reader delegates these to `GenerationOneDecisionSupport` inside its
profile. It derives walking/cycling collision, objects/signs, warps, connections,
and local shortest first inputs from live RAM and read-only cartridge slices.
`RomReader` is optional; Game Boy reads copy at most 16 KiB and validate bounds.
Keep ROM bytes/assets out of observations, logs, and the viewer. Cache only up to
four immutable ROM banks, clear on reset/restore, and recalculate live routes.
Yellow collision tables use bank 1, unlike Red/Blue's fixed bank. Preserve unknown
surfing/Strength controls and warp-underfoot triggers. The reader distinguishes
turning from walking, waits during live movement, and excludes confirmed blocked
walking. Route facts alone never select a goal, execute a path, or verify completion.
Local mechanical routes from the house floors into Pallet Town and through
Oak's encounter into his lab were checked for all three revisions using an
offline fixture decider, without paid requests or changing the original saves.
Synthetic tests cover legality, timing, interruption, and frame ceilings.

`PokemonBattleSupport` is another profile-local reader adjunct. Exact battle
layouts read move records/names and the Gen I type chart from the user's ROM,
not a bundled asset dump. Cache at most 165 decoded moves and a bounded chart;
reset/restore clears them. Active normal-battle moves expose names, types,
power, approximate base accuracy, PP, effect hints, STAB and combined distinct
enemy-type factors. Status/special rules must not be presented as ordinary
damage estimates. Unknown tables/types remain unknown. A verified regular move
menu offers usable `use_move_1..4` slots, excluding no-PP and disabled choices.
The bounded executor follows only Jev's selected slot and confirms once; changed
actors/moves/PP/Disable or a closed menu end execution. Guard delayed generic A
against highlight changes, while selected-slot actions tolerate cursor movement.
Temporary menu printing settles locally. Tests use invented tables; local
cartridge metadata checks cover all three and a Red replay verified slot 2
execution without APIs or overwriting the original checkpoint. This does not
establish full battle legality, damage prediction, or live Jev performance.

`PokemonBattleFlow` distinguishes normal-battle fainting transitions from
verified bottom text continuation prompts. A decoded 0-HP actor with no
visible choice/continuation requests neutral settling through `faint_pending`;
the runner skips Jev and vision for at most 600 frames, then preserves unknown
controller attempts. A complete dialogue box/arrow without a cursor or naming
grid exposes `text_acknowledgment`, A/B/stop and clear input-needed facts,
excluding ineffective wait/directional/menu inputs. Only Jev chooses the
single-frame acknowledgment; never auto-press through text or a party/YES-NO
choice. One private fingerprint retains meaning across arrow blinking and
changes with text/actors/screen; reset/restore clears it. Stale move names with
fainted actors are not `moves_pending`. Synthetic checks cover all three;
an isolated Red replay verified one fixture-selected A reaches EXP text after
600 neutral frames failed to advance the fainted message, with no API requests
or changes to the original checkpoint. This is not full switching legality
or live Jev validation.

`PokemonItemSupport` owns inventory, capture and Mart choices inside the profile.
Exact `item-layout.ts` addresses decode at most 83 ROM item names/prices; reset
and restore clear that catalog and private menu snapshots. Expose ordinary ball
counts, bounded named inventory facts, party/storage capacity and known capture
evidence; catch-rate thresholds are not probabilities. Unknown team types do
not establish missing coverage. Normal verified wild commands/moves offer
`open_capture_bag`; a verified bag offers `throw_ball_slot_N`. Jev selects each
step. Exclude trainers, demo/Safari, dead/transitional actors, full party plus
full/unknown storage and unverified Tower ghosts/scripted Marowak. Executions
follow the same selected bag/item, confirm once, settle opening within 120
frames and stop on context changes or the 600-frame ceiling. Generic A protects
the inventory/highlight meaning. Nickname grids precede lingering battle flags.

Verified priced Mart lists offer `choose_shop_item_slot_N` only for known
affordable/storable items. Selecting opens quantity; never buy or choose a
quantity inside that executor. Cursorless purchase quantity prompts require
matching RAM/display values and expose only A/B/UP/DOWN with quantity keys.
Jev separately confirms the total price. Unknown, selling and other item menus
retain controller attempts. Visible pickup labels require cartridge item flags
and matching live sprites; starter balls/trainers are not loot. Hidden items
are not enumerated. Collection remains an attempt until observed state changes.
Early missing-ball guidance uses Viridian/Pewter Mart goals, at most four
goals per distance query and one retained distance table. It must not choose
a service detour or overwrite the story goal. Editable defaults add preparation,
capture and loot constraints while preserving the exact 16 milestone strings.
All three local cartridges verified item names/prices and visible forest object
metadata. An isolated Red replay selected a Mart item, bought one ball and threw
that selected ball without capturing the target. It used fixture choices, no
APIs, and preserved the original checkpoint; this is not live Jev validation.

Readers optionally implement `setObjectives`, `createExecution`, `shouldWait`,
and `onActionComplete`. Completion feedback receives the selected action, actual
frames, interruption status and validated before/after state when available;
cancelled actions have no after-state. Forward it through state/vision observers
once per executed action. It may retain bounded profile memory, never select
inputs or advance the emulator.
An offered `execution: "profile"` action has no fixed buttons and a 1–600-frame
ceiling. Only Jev selects it. Its read-only executor emits one validated frame
step at a time toward the same target; the runner owns advancement, the ceiling,
and four release frames. Never substitute another target or recovery action.
Pause/settings/reset/restore/shutdown cancel execution, with one finish callback.
Records include actual frames and execution reasons. Local settling skips both
Jev and vision for at most 600 neutral frames between requests, then asks again;
session limits and cancellation still apply. These hooks propagate through state
and optional vision observers without game-specific code in the runtime.

Pokemon destination actions cover up to 20 local exits/boundaries/objects/signs.
Their executor retains the selected ID/context, waits for walking, sends one
interaction pulse, and stops for map change, dialogue/battle/menu, ignored controls,
unreachable targets, 120 frames without movement, or its ceiling. After map changes
the reader settles 60 frames. Target feedback retains at most 32 contexts and
best distances: repeating an earlier partial approach is not new navigation
progress. Reset/restore, objective edits, and relevant story/item/party evidence
invalidate that feedback. No sampled fallback, checkpoint rescue, or hidden
controller decision may be added.

Adjacent warp entries with the same destination share a route. Decode automatic
warp tile lists from the cartridge's revision-specific `WarpTileIDPointers`
before exposing facing-edge triggers; stairs are not edge exits. Mark the
applicable outward direction `exit_trigger`, retaining bounded controller inputs.
Sideways movement between equivalent exit mats does not activate the boundary
exit. Preserve attempts for unknown/special warp rules. The latest Red checkpoint
at the ground-floor mats and house routes for Blue/Yellow were checked locally.

Readers may expose validated optional `defaultObjectives`; JSON profiles use
the same property. Preload these in manual/agent Settings and allow CLI agent
startup without objectives only when reader defaults exist. Pokemon supplies
16 editable story milestones, with Yellow's distinct starter guidance. The
Settings `Use game defaults` button edits the draft; normal Apply validates
the revision and pauses/cancels work. Preserve user edits and session ceilings
across ROM changes; refresh unchanged reader suggestions for the new reader.
`PokemonStoryProgress` interprets exact default milestone strings that remain
in the supplied objectives and reports `activeMilestone`, its goal/map, and
`completedStoryChecks`. Checks use named events, badges, full bag item IDs, and
an explicit session-local Lavender arrival checkpoint; they do not verify every
instruction, team preparation, custom prose, or full-objective completion.
Opening event bits 0/34/35/57/37 identify Oak, starter, rival, parcel, and Pokedex.
The hideout boss flag alone does not prove the Silph Scope was collected.
Map metadata comes from revision-specific cartridge header tables, not bundled
assets. Static regional guidance additionally decodes tileset blocks and collision
lists, separates disconnected walking areas, preserves tile pairs and directed
ledges, treats warps as endpoints, and uses exact warp/connection landing squares.
It labels closer/farther/unknown exits to the active supplied milestone's map;
coarse map distance alone must not label an exit as onward travel. Bound derived
topology to 248 maps, 16,384 squares per map, 262,144 total squares, 32,768 nodes,
65,536 edges, and one objective-distance table. Reset/restore clears topology;
navigation raw ROM caching remains four banks. Static geometry does not verify
scripts, moving actors, HMs, puzzles, special warps, or goal completion. Local
action availability continues to use fresh RAM. The south forest gate's forward
and return landing distances were checked against all three cartridges without
API calls; synthetic tests cover disconnected areas, gates, ledges and unknown data.
Preserve all user constraints and leave target selection to Jev.

PokemonTravelMemory retains at most 32 settled map crossings independently of
the short decision history. It exposes repeated immediate returns and the exit
back to this visit's entry map, without removing legal backtracking choices.
Movement, menus, transitions and duplicate snapshots do not count as arrivals.
Tracked story checks, badges, bag contents, party count, objective edits and
reset/restore clear it. HP/PP/level changes alone do not verify navigation progress.
`PokemonFocusMemory` adds a Jev-selected purpose after Pokedex/party evidence.
Settled exploration without a purpose offers input-free focus choices and stop;
executing the selected purpose stores it without choosing a controller input or
destination. Map changes and incidental battles retain it. Service routes use
up to four known Mart/Center candidates per query, up to eight cached candidate
IDs for the current map and one retained distance table. Live clerk/nurse and
cartridge trainer labels distinguish arrival from the task inside. Decode at
most 47 trainer-class names, 24 bytes each, from exact revision tables and match
live pictures; unknown identity stays unknown. Train/catch purposes offer
up to four local land-encounter targets and finish on the selected square or
interruption. Regional encounter routes use at most four candidates, verified
walking areas/landings and the same single distance table as other goals;
retain only four encounter candidate IDs. Special service scripts remain unknown.
Completion feedback retains up to 64 map/action attempts, six best distances
and six purpose-selection counts. Repeated old distances, crossings and menus
are not new progress. Six actions without a new best distance or 32 actions
since selection require another purpose choice in settled exploration, retaining
outcome evidence. Reads, cancelled/purpose actions and battle actions do not age
navigation memory. Level gains count only for training. Story/badge/owned/team,
fainting/preparation health bands, objective edits and reset/restore clear relevant
focus evidence. Inventory-only changes preserve a Jev-selected capture purpose
and refresh its stage distances; other purposes reconsider bag changes. Known
full HP, cleared status and full move PP reconsiders healing. Preserve legal
backtracking and all user constraints. A copied
Red checkpoint reached a priced Mart list and approached the selected Brock
target until an intermediate trainer script interrupted it using offline fixture
choices and no APIs; the original save was preserved. This is not live Jev or
full-game validation. Dynamic regional refinements remain future work; never
copy the reference project's sampled alternatives or checkpoint rescue.

`PokemonPreparationSupport` is a profile-local adjunct, independent of Jev and
vision. It derives per-member HP percentages, status and ordinary attack PP risk,
supplies, backup advice and upcoming recognized challenge teams. HP at 50% or less,
faint/status and quarter-or-less attack PP prioritize a Center;
below-30% HP, status and PP bands prompt reconsideration, without excluding legal
progress choices. A zero status byte means no status condition, not full recovery.
`PokemonMoveCatalog` shares the bounded 165 moves/type chart with battle support;
max PP includes Gen I PP Ups (each bonus is floor(base/5), capped at seven).
`preparation-layout.ts` supplies exact Red/Blue versus Yellow cartridge offsets.
`PokemonPreparationCatalog` caches at most 190 decoded species, 248 maps with
ten land encounter slots and 16 trainer-party results of up to six members.
Invalid pointers/records remain unknown; reset/restore clears all decoded caches.
Never expose raw ROM tables. Recognized pending leaders and the first four Elite
Four teams use actual cartridge levels/types; custom goals and the final Champion
variant remain unknown. Compare known usable ordinary attacks through the Gen I
chart, excluding status/special moves. Potential species types are not proof of
learned attacks, damage or victory. A city can offer capture purpose with known
encounters, capacity and balls or affordable supplies; with no balls, its routes
match a Mart/clerk before encounter areas. Every service, purchase step, target,
move and ball still requires Jev's selection. Grassless indoor maps and revision
half-block tiles are distinguished; exclude water shores, Safari and unverified
Tower routes. Scripts/repel/HMs can invalidate static access. Synthetic tests cover
prerequisites, injured teams, PP recovery, unknown data, persistence and bounds.
Read-only cartridge checks verified teams/encounters for all three; a copied Red
checkpoint replay restored HP and all four PP at Pewter Center and separately
reached the Mart's priced list under capture purpose, using fixture decisions,
no APIs and no save writes. This is not live Jev strategy or capture success.

Post-battle healing review waits for settled valid party data and requests a new
Jev purpose when healing is needed, even within an unchanged health band. An
existing healing purpose persists; urgent preparation also offers a direct
Jev-selected healing switch. Bounded priority facts precede general context.
Eligible wild species absent from the current team are prioritized independently
of Pokedex ownership or new types, including ball and attack descriptions.
Missing balls prioritize known affordable/storable Mart choices. Unknown party
identity, capture exclusions, quantity/price confirmations and user constraints
remain authoritative. Verified live pickups within eight interaction steps get
priority independently of purpose, with urgent healing first; known full stacks,
invalid inventory, hidden objects, starters and NPCs never establish collectibility.
At most eight priority pickup/stair actions remain during purpose selection.
For known automatic stair landings, withhold ineffective zero-distance exits and
offer at most four explicit adjacent non-warp step-off targets. Each stops at its
selected square; returning needs another Jev-selected exit. Only a known closer
landing marks a return as matching the selected purpose. Preserve unknown warp
attempts and legal backtracking. A copied Red Mt. Moon checkpoint verified the
selected step-off/re-entry and subsequent healing-route distinction with fixture
decisions, zero APIs and no original save writes; live Jev adherence is unverified.

`PokemonInteractionMemory` keeps at most 32 map/position/facing interaction
records and eight recent text fragments per active dialogue. It exposes bounded
text and counts after a live bottom dialogue box/font flag returns to the
overworld. Duplicate reads do not increment counts; menus/transitions do not
close dialogues. Compare observed durable decoded fields and 320 event-flag
bytes, keeping raw flags local. Warn that A starts another interaction after
an unchanged dialogue, but retain A and avoid claiming verified progress or
actor identity. Tracked state changes invalidate the warning. Reset/restore
and history resets clear this memory; emulator checkpoints do not persist it.
The saved Red mother conversation was replayed locally without provider calls.

Readers can supply optional `decisionSupport.decisionGoal`, a nonempty immediate
task up to 500 characters. Preserve it through state/vision observation and
inspection; the generic Jev question considers it before distant milestones
without overriding supplied constraints or executing it. Pokemon supplies
phase-specific tasks for healing, pickups, actual capture eligibility, and shop
steps. Never warn to preserve a wild target for capture when no verified balls
or capture eligibility exist. Dialogue retains the selected purpose but does
not establish that the current actor is its nurse/clerk.

`battle-effects.ts` decodes six live stat stages per actor from exact shared
CD1A/CD2E addresses, 1-13 encoding -6 to +6. Pure changes at their cap, Splash,
Dream Eater against a known awake target and ordinary damaging immunity supply
failure facts. With another known usable move, withhold the failed slot and A
on its highlight; otherwise retain explicit bounded attempts. Preserve unknown
effects and special damage. Explain physical Attack/Defense versus Gen I
Special. Selected move executors can open verified FIGHT first, settling within
120 frames and retaining the same slot/context under a 600-frame ceiling.
`run_from_wild` is one Jev-selected normal living wild escape attempt, never
offered for trainers or automatically retried. `text_pending` and `actors_pending`
settle at most 600 neutral frames without Jev/vision, including actor initialization;
prompt identities still protect delayed acknowledgments. Never auto-answer text,
party, naming or YES/NO choices. Isolated Red fixture replays verified one PP/
enemy-HP change and the Growl -6 cap after six effective uses with zero APIs and
unchanged original saves; this is not live Jev validation or full battle legality.

Long navigation yields to Jev on a newly nearby verified collectible after
walking settles, without selecting or collecting it. Initial known pickups and
other pickups during a selected pickup do not force repeated interruptions.
Navigation availability keys include a bounded nearby-pickup mask so late
responses are refreshed when opportunities change. Rank the bounded service
catalog by exact current walking-area distance before caching four candidates
per service kind (eight total). Each query has at most four goals and one
retained distance table; area changes/reset/restore invalidate the shortlist.
Do not let four coarse nearby but disconnected services hide a reachable one.
Shop stock, prerequisites and scripts remain independently unverified.

The pinned bridge releases input after every hardware frame. Pokemon text/menu/
naming A/B confirmations therefore use one frame, preventing repeated confirmation
or reopening a dialogue within one action. Semantic move/item/command cursors end
their directional pulse once the selected slot/coordinate is observed, including
fixtures that repeat input every frame. Preserve the selected target, one explicit
confirmation and the normal runner release frames. Unknown controller attempts
keep bounded durations; these changes do not establish full-game competence.

A further copied Red checkpoint replay bought one ball at Viridian Mart and
threw that selected ball on Route 1, with observed inventory consumption, zero
API requests and unchanged original saves. The target was not captured. These
fixture choices verify purchase/throw mechanics, not live Jev capture strategy.

`PokemonCaptureSupport` is a read-only adjunct sharing the bounded move catalog.
Eligible captures expose each available ball's rounded Gen I HP plateau and
uniform-random per-throw estimate, never the raw catch-rate byte as a percentage.
The plateau is near 33% for Poke/Ultra and 50% for Great, with earlier integer
rounding and small-HP exceptions. Master Balls ignore HP and remain scarce.
Known usable single-turn ordinary attacks supply approximate normal/critical HP
risk from live modified stats, matching unmodified party/wild stats, Gen I type
categories, STAB and distinct-type factors. Do not apply live stages/burn twice.
Unknown stats/chart/actors and special, multi-hit, charging, trapping, recoil,
self-KO/residual effects do not establish a cautious attack. Critical estimates
bypass screens/stages and use doubled level; estimates omit intermediate type
rounding and future enemy actions, so never promise safety or exact damage.
The immediate task requests one cautious weakening choice and a fresh HP review,
or a ball at a plateau/KO risk/unknown risk/urgent low HP/residual target risk.
An early bag explains B returns before a separately selected move. Keep early
throws and otherwise legal attacks; never automatically weaken, throw or retry.
Relevant preparation/stat changes refresh action availability keys. Synthetic
fixtures cover Red/Blue/Yellow. A read-only copied Red battle verified decoded
Scratch HP-risk advice and a rounded 7/15 Poke Ball plateau using one hypothetical
ball, with no inventory edits, frames, APIs or original save writes. This verifies
metadata-backed advice, not capture success or live Jev strategy.

`PokemonNamingSupport` and `PokemonPartySupport` keep names separate from slot
identity. Recognize player/rival and Pokemon grids with validated buffer/length/
cursor; cursor markers between letters must not hide the alphabet. Offer at most
four whole-name actions, each typing only Jev's selected A-Z name with single-frame
keys and one START, bounded to 600 frames. Keep player/rival names within seven
characters and Pokemon within ten. A standalone `Pokemon names: EMBER, WING`
constraint or milestone supplies up to 16 preferred names. Avoid case-insensitive
duplicates in live party/current-box names and up to 32 recently observed names;
unseen boxes remain unknown. Reads never rename existing members; reset/restore
clears private memory and objective edits refresh suggestions.
Verified unboxed party rows expose slot/species/level/HP and their real cursor
even with identical nicknames. Normal battle selection excludes active/fainted
members and A on those highlights. Jev separately confirms SWITCH for a voluntary
selection; forced/between-opponent choices may send the selected member directly.
`open_party_menu` opens only POKEMON; choosing a member remains separate. Voluntary
switching explains cancellation may retain a stronger member. Withhold ineffective
waits in verified party/name choices and obey the live party B-key mask.
Visible party input must not be treated as neutral faint settling. Unknown
variants, reordering, field moves and complete switching legality remain partial.

Medicine advice recommends small affordable/storable reserves of two HP-restoring
items and two Antidotes, preserving money needed for balls. Jev chooses each item,
quantity and total-price confirmation. Stock removes reserve priority. Shared
profile-local `medicine.ts` distinguishes ordinary Potion variants/Full Restore
from Antidote and matches live battle HP/status to the active party slot.
`open_medicine_bag` opens battle ITEM or field START/ITEM and stops at the bag;
`choose_medicine_slot_N` selects a known useful medicine. Field USE is another
Jev choice. A verified medicine party list offers beneficial
`apply_medicine_to_slot_N` choices with one confirmation, no alternate target and
a 600-frame ceiling. Verify the saved bag slot, stock, list pointer and item-name
buffer: current-item RAM aliases species data during party drawing. Unknown
medicine identity retains bounded attempts and explains cancellation. Poison/
status or active HP <=30% can prioritize battle medicine; outside battle, status
or HP <=50% prioritizes known beneficial inventory. Potions do not cure poison,
Antidotes do not restore HP, and these medicines do not restore PP or revive.
Centers remain relevant. Reset/restore and changed item/party/menu meaning
invalidate execution; never auto-use or retry. Defaults now have six constraints
and preserve the exact 16 milestones. Synthetic checks cover all three readers
and a three-decision offline Antidote/USE/slot session with zero HTTP attempts;
live Jev strategy remains unverified. A copied Red checkpoint with duplicate
`AAAAAAAAAA` names verified opening POKEMON, selecting slot 2 and separately
confirming SWITCH: the active species changed from Charmeleon to Pidgey after
14 fixture actions, zero API requests and no original save writes. This proves
targeting rather than the usefulness of that switch.

Agent session JSONL records include local diagnostics for readers, decisions,
response validation, and HTTP attempts. `--debug` prints them and also enables
manual-session records. Redact credentials, exclude raw provider response bodies,
deduplicate unchanged reader snapshots, and cap each recording at 32 MiB. Keep
a rolling chronological window: evict oldest complete JSONL lines in batches,
retain recent events in the same file, and continue recording. Use bounded
copy buffers; an oversized individual event gets a metadata-only omission
marker without stopping subsequent events. Notify once at the first eviction.
Completed actions record bounded local before/after state differences at actual
execution frames. Decision feedback tracks up to 32 recurring observations,
unchanged actions, action cycles, and stable fields, including menu reopen loops.
Treat that evidence as observed changes rather than verified goal progress or
collision data. Keep recovery choices attributable to Jev. The Gen I reader
identifies the complete START menu and excludes confirming its POKEMON entry
when the party is empty; unrelated menus and other controls retain their actions.

The viewer's Settings → Agent editor changes objectives and session ceilings
without restarting. Updates pause the agent, cancel pending work, preserve
counters and elapsed time, and propagate action duration to the observation
strategy. Validate complete updates and their revision before applying them.
Explicit `--unlimited` or null ceilings disable session limits; action durations,
HTTP timeouts, retries, payloads, history, and recordings stay bounded. Jev's stop
action remains unverified completion until a profile supplies verified progress.

`npm start` without arguments launches the included demo paused in manual mode
and opens Settings → ROMs. `.env` is loaded at startup for manual and agent play.
Settings → Agent → Mode & models chooses manual/agent play, independent Jev and
vision providers, and bounded model IDs. Expose configured-key availability only,
never key values; key presence is not verified provider access. Runtime changes
validate the full selection/settings and revision before pausing or cancelling.
They preserve emulator state, existing agent counters, shared request attempts,
and elapsed time, and clear recent history/inspection when the selection changes.
Keep a paused agent and its budget while playing manually; re-enabling it must
not reset limits. The timer starts at first activation and includes manual time.
Carry applied settings and provider choices across ROM changes, including from
manual mode. New cartridges get fresh sessions. Reject stale viewer commands
and inspection after mode/model edits as well as cartridge switches.

Viewer speed is configurable at startup and in Settings → Session, up to 32×.
Frame pacing scales its bounded batch with speed and resets on speed edits and
resume. Viewer emulation and audio continue with buttons released during a single
pending observation/decision. Recheck local reader action availability before
execution; discard obsolete actions and request a fresh decision without pausing,
while counting their responses toward limits. Record observation and execution
frames separately. Headless requests retain deterministic frame counts.
Optional action `availabilityKey` strings (1-128 characters) distinguish meaning
changes even when IDs/buttons/durations match. Gen I keys distinguish phases,
overworld positions/facing, menu/naming context, and dialogue episodes without
invalidating responses for partially printed text. Record old/current keys on
discard; keep the decision attributable to Jev and request fresh state.
Speed edits preserve pending agent work,
action durations, and pause state, and invalidate queued audio on both ends.

Settings → ROMs loads regular .gb/.gbc files from the local roms/ folder, capped
at 8 MiB and 256 catalog entries. Reject traversal and symlinks. Validate a fresh
runtime before replacing the current cartridge, save the previous checkpoint,
cancel stale work, and start the new game paused. Preserve custom objectives,
session ceilings, and provider choices; refresh unchanged reader suggestions.
Reset session counters, timers, history, and inspection.
`src/runner/game-runtime.ts` owns per-cartridge readers, providers, logs, and
cleanup. Checkpoints after switching are isolated by console and ROM hash.
Interactive startup and library loads automatically restore the latest compatible
checkpoint for that game when present; absent saves start from boot. Startup uses
`--save` when supplied and explicit `--load` takes precedence. Headless execution
resumes only with explicit `--load`. Validate restored reader state before replacing
the current game, invalidate reader caches, and retain the current paused cartridge
and both saves on restoration failure. Reloading the current ROM uses the current
snapshot that is saved by the load, preserving unsaved progress. Library loads
remain paused and never request model decisions during restoration.
Settings → Session → Checkpoint offers optional autosave, off by default, with
independent bounded intervals of 1–10,000 new Jev decisions (default 25) and
1–86,400 active manual seconds (default 60). Defer a due agent save until its
current input finishes; HTTP attempts and local settling are not decisions.
Exclude paused manual time and keep time independent of emulation speed. Runtime
updates validate the complete settings, revision, and game ID without pausing or
cancelling model work. Keep settings across ROM/mode changes in the viewer run;
reset scheduling on settings/mode/cartridge/save/reset/restore changes, and clear
per-cartridge save status when switching. Keep one background write in flight;
explicit checkpoint operations, ROM changes, and shutdown wait for it. Atomically
replace a checkpoint using a complete sibling temporary file and clean failed
temporary writes. Expose bounded failure messages without stopping gameplay or
retrying every tick. Headless save behavior remains explicit.
Guard browser commands and inspection against stale game IDs. Never expose
ROM bytes, absolute catalog paths, or provider credentials through the library.

Use `npm ci` to install dependencies, `npm start` for the interactive launcher,
`npm run demo` for the original synthetic ROM, or `npm start -- --rom "roms/my-game.gb"`
for a local ROM. Validation uses
`npm run typecheck`, `npm test`, and `npm run build`, or `npm run check` for all
three. Tests do not require commercial ROMs or API access. CI targets Windows
and Linux. Keep these commands and the README aligned with actual behavior.

## Scope and Technical Direction

- Start with Game Boy emulation. Document the supported ROM formats and emulator
  limitations; verify Game Boy Color support before advertising it.
- Prefer TypeScript with strict typing and Node.js for the initial implementation,
  subject to emulator compatibility. Record the chosen runtime version and
  dependencies when implementation begins.
- Keep the first deliverable small: a configurable, headless gameplay loop and
  a deterministic mock decision provider. Add a viewer when it helps inspection.
- Keep ROM paths, objectives, provider settings, button durations, session limits,
  and output paths configurable. Avoid machine-specific paths and shell commands.
- Support development on Windows and document any platform restrictions.

## Architectural Boundaries

Use explicit interfaces between the following components. The emulation,
configuration, observation contracts, game-reader strategies, Jev adapters, and
runners below exist. Visual perception lives in `src/vision/`; HTTP transport
and budgets live in `src/providers/`. The viewer lives in `src/server/` and `web/`.

| Component | Suggested location | Responsibility |
| --- | --- | --- |
| Core contracts | `src/core/` | Observations, actions, decisions, objectives, and session state |
| Emulator adapter | `src/emulator/` | Load a ROM, advance frames, press and release buttons, capture frames, and save or restore state |
| Observation provider | `src/observation/` | Convert emulator output into useful state for decisions |
| Jev provider | `src/jev/` | Authenticate, submit structured questions, validate responses, and apply request limits |
| Game profiles | `src/profiles/` | Optional game-specific observation, action descriptions, and progress checks |
| Session runner | `src/runner/` | Coordinate observation, decision, execution, checkpoints, and stopping |
| Configuration | `src/config/` | Validate user-supplied settings and load objectives |

- The core must not contain game names, RAM addresses, map layouts, battle rules,
  walkthroughs, or hardcoded progression logic.
- Keep the pinned backend's private-core access inside
  `src/emulator/game-boy/serverboy.ts`. It normalizes CPU timing and snapshots.
  Validate console extensions against the common contract and their own fixtures.
- Game profiles may provide richer observations and actions, but the core must
  not require a particular game's disassembly, symbols, or memory layout.
- Game readers implement `GameReader` and are created per session by the
  registry. Match the console and exact ROM hash; do not infer compatibility
  from filenames or game titles. Reads must not mutate or advance the emulator.
  Invalidate optional reader caches on reset and restore.
- Readers supply semantic state and current action availability. Vision adds
  evidence and cannot overwrite memory-derived fields or choose actions.
  Validate the current action set before asking Jev and execute only a member
  of that set. Unsupported memory-only ROMs need a reader; emulator metadata
  alone is not a semantic observation of arbitrary games.
- Keep emulator frame advancement separate from model request timing. Bound each
  action by a configurable number of frames and reliably release held buttons.
- Treat game mechanics as optional capabilities exposed by a profile. The generic
  action space should use supported controller inputs and bounded waits.
- Separate emulator compatibility from gameplay competence. Loading a ROM does
  not demonstrate that the agent understands the game or can meet its objectives.

## Observation and Jev Decisions

[TypeSafe's official documentation](https://docs.typesafe.ai/introduction)
describes Jev as a model that evaluates state and typed questions. Design gameplay
decisions around selecting from explicitly supplied actions.

- Do not assume Jev can interpret screenshots, generate a plan, or output arbitrary
  controller instructions. Verify capabilities against official documentation.
- A captured frame is emulator output, not automatically a useful Jev observation.
  Define how screen content becomes decision state: for example, a separate visual
  perception provider or an optional game-specific memory reader.
- Keep additional perception dependencies and credentials explicit. The desired
  ROM/objectives/Jev-key setup requires a working observation strategy; do not
  conceal another required service or claim this experience before it is verified.
- Send objectives, relevant observations, recent action history, and the available
  actions to the decision provider. Bound history and payload size.
- Give actions stable identifiers and informative descriptions. Execute only an
  identifier from the supplied action set, after runtime validation.
- Keep all gameplay decisions attributable to Jev. Record any configured recovery
  behavior or fallback so it is distinguishable from model-selected actions.
- Put provider-specific endpoints, SDKs, model names, and authentication in the
  Jev adapter. Check official documentation before implementing an integration;
  do not invent an API contract or assume gateway keys are direct TypeSafe keys.
- Include timeouts, bounded retries, throttling, and configurable call limits.
  Stop or pause cleanly when credentials, provider responses, or limits fail.
- Vision and Jev share the request budget. Count every application HTTP attempt,
  including failures and cancelled requests. Use the documented Gateway HTTP
  and direct TypeSafe HTTP endpoints and validate their different response formats
  without adding SDK dependencies. Keep credentials, model IDs, native confidence,
  and token usage mapping specific to each adapter. Invalidate pending
  observations and decisions on pause, reset, restore, and shutdown.
- Provide a mock mode that works without credentials, network calls, or API costs.
- Keep `--agent` and `--vision` independent. A mock decision provider can still
  use remote vision; report that combination accurately in the viewer and logs.
  Preserve `--observation state|vision` compatibility and reject conflicting flags.

## Objectives and Session Records

- Load explicit objectives from user configuration or a separate file. Optional
  editable defaults belong to game profiles, outside the shared runtime. Support
  a primary goal and optional constraints or milestones.
- Distinguish a stated objective from evidence of completion. Use explicit progress
  checks when available and clearly identify unverified or manual completion.
- Record enough information to inspect a run: observations, candidate actions,
  selected action, frame counts, provider metadata, progress, and stop reason.
- Support bounded sessions and graceful interruption. Detect repeated states or
  ineffective actions and expose that evidence to the decision provider.
- Keep checkpoints and recordings local by default. Any resume behavior must
  validate compatibility with the ROM, emulator, and relevant profile.

## Public Repository Hygiene

- Never commit ROMs, API keys, private `.env` files, local save states, runtime
  screenshots, recordings, logs, or generated game data. Add appropriate ignore
  rules before introducing these files.
- Provide placeholder credentials in `.env.example` when configuration exists.
  Keep credentials out of logs, error messages, and any browser-facing viewer.
- Users supply their own legally obtained ROMs. Do not distribute commercial game
  assets or add links for downloading unauthorized ROM copies.
- Review emulator and other dependency licenses before choosing the repository
  license. Preserve required attribution and obligations for reused code.
- Use synthetic fixtures or appropriately licensed homebrew for automated tests.
  Default tests must not require commercial ROMs, real keys, or paid API requests.

## Implementation and Validation

- Implement a runnable vertical slice before adding more emulator backends, game
  profiles, UI features, or abstractions. Keep modules focused and dependencies few.
- Validate configuration, action bounds, and external responses at runtime; static
  TypeScript types alone do not validate files or network data.
- Test meaningful boundaries: invalid actions must not reach the emulator, held
  inputs must be released, session limits must stop execution, and provider failures
  must not create an uncontrolled loop.
- Exercise the session loop with a deterministic emulator fixture and mock Jev
  provider. Test the actual emulator separately with an appropriate ROM fixture.
- Run the relevant checks available in the project after code changes. Report what
  was verified and any remaining limitation without claiming universal gameplay.
- Document actual installation, configuration, mock execution, live execution,
  stopping, and adding a game profile as those workflows become available.
