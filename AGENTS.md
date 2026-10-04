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

Readers optionally implement `setObjectives`, `createExecution`, and `shouldWait`.
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
Persistent Jev-selected focus and dynamic regional refinements remain future work;
never copy the reference project's sampled alternatives or checkpoint rescue.

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
