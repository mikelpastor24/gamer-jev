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
shared English Gen I decoding from the exact Pokémon Red layout and ROM hash.
Red startup, naming, the starting room, and overworld menus were checked locally;
party/battle decoding uses synthetic RAM tests. Other Pokémon readers, collision
maps, full-game competence, and verified progress checks remain future work.

Agent session JSONL records include local diagnostics for readers, decisions,
response validation, and HTTP attempts. `--debug` prints them and also enables
manual-session records. Redact credentials, exclude raw provider response bodies,
deduplicate unchanged reader snapshots, and cap each recording at 32 MiB.

The viewer's Settings → Agent editor changes objectives and session ceilings
without restarting. Updates pause the agent, cancel pending work, preserve
counters and elapsed time, and propagate action duration to the observation
strategy. Validate complete updates and their revision before applying them.
Explicit `--unlimited` or null ceilings disable session limits; action durations,
HTTP timeouts, retries, payloads, history, and recordings stay bounded. Jev's stop
action remains unverified completion until a profile supplies verified progress.

Viewer speed is configurable at startup and in Settings → Session, up to 32×.
Frame pacing scales its bounded batch with speed, discards provider wait time,
and resets on speed edits and resume. Speed edits preserve pending agent work,
action durations, and pause state, and invalidate queued audio on both ends.

Use `npm ci` to install dependencies, `npm run demo` for the original synthetic
ROM, and `npm start -- --rom "roms/my-game.gb"` for a local ROM. Validation uses
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

- Load objectives from user configuration or a separate file, rather than source
  code. Support a primary goal and optional constraints or milestones.
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
