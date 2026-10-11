# Agent sessions

[Documentation](README.md) · [Project overview](../README.md)

## Enable agent play

Copy `.env.example` to `.env`, set the keys you want to use, and run `npm start`.
The server reads `.env` even for manual play. **Settings → Agent → Mode & models**
lets you choose **Manual** or **Agent**, the Jev provider, and vision independently.
Providers with no configured key are disabled; mock providers remain available
offline. Key presence does not verify credits, account access, or model support.
The browser receives provider availability and model identifiers, never API keys.
Restart the application after editing `.env`.

Model fields start with `TYPESAFE_MODEL`, `JEV_MODEL`, or `VISION_MODEL` from `.env`
and can be edited in the application. Jev remains a TypeSafe decision model;
Gateway vision requires a model that supports image inputs. Set an objective
in **Objectives**, or edit the suggestions preloaded by a compatible reader;
optionally adjust **Limits**, and use **Apply changes**.
Applying pauses the game and cancels pending work; close Settings and Resume.
Switching modes, providers, or models preserves the cartridge, agent counters,
request budget, and elapsed time. It clears recent history and inspection so
the next decision uses the current game state. Manual play makes no model calls.
The session timer begins when the agent is first enabled and includes later
pauses and time spent in manual mode. Loading a ROM starts a fresh session and
keeps applied mode, model choices, objectives, and limits.

## Providers and credentials

You can also choose the decision provider with `--agent` and the visual provider
with `--vision`. Every combination is supported:

| Component | Option | Credential |
| --- | --- | --- |
| Jev directly through TypeSafe | `--agent typesafe` | `TYPESAFE_API_KEY` |
| Jev through Vercel AI Gateway | `--agent gateway` | `AI_GATEWAY_API_KEY` |
| Predetermined local decisions | `--agent mock` | None |
| No vision; requires a compatible memory reader | `--vision none` | None |
| Vision through Vercel AI Gateway | `--vision gateway` | `AI_GATEWAY_API_KEY` |
| Fixed local visual descriptions for testing | `--vision mock` | None |

Omit `--agent` for manual play; `--profile` can still enable local state inspection.
Copy `.env.example` to `.env` and set only credentials for the providers you
select. Obtain a direct key from the [TypeSafe console](https://console.typesafe.ai/)
or a [Vercel AI Gateway key](https://vercel.com/docs/ai-gateway/getting-started).
The two credentials are not interchangeable. If both models use Gateway, one
Gateway key authenticates both.

For example, use only Jev directly with the demo's automatically selected reader:

```dotenv
TYPESAFE_API_KEY=your-typesafe-api-key
```

```sh
npm start -- --demo --agent typesafe --vision none --goal "Increase scrollX"
```

For a ROM without a reader, start with vision:

```sh
npm start -- --rom "roms/my-game.gb" --agent gateway --vision gateway --goal "Start the game and complete the first level"
```

Or use direct TypeSafe decisions with Gateway vision. This combination needs
both keys:

```sh
npm start -- --rom "roms/my-game.gb" --agent typesafe --vision gateway --goal "Start the game and complete the first level"
```

Open the printed viewer URL to watch the session. **Pause** cancels pending
requests and discards their decisions. **Resume** requests a fresh observation.
The panel shows each selected provider, the objective, observation, chosen input,
confidence when reported, decision count, request count, and stop reason. Manual button
input is disabled during agent sessions. Checkpoints and screenshots still work.

Existing commands keep their defaults: a live agent uses Gateway vision, and
a mock agent uses mock vision, unless `--vision` is specified. The compatibility
option `--observation state` means `--vision none`; `--observation vision` enables
the default visual provider. Conflicting `--observation` and `--vision` options
are rejected. With vision, no game-specific reader is required. The default
Gateway vision model,
`google/gemini-2.5-flash`, describes the current screenshot and compares it with
the previous observation. Jev receives structured game state,
any visual description, objectives, recent action results, repeated-screen
evidence, and the current available actions. A compatible reader supplies
semantic state and filters those actions; otherwise vision uses generic
controller actions and explicitly labeled emulator metadata. Jev selects the
action; vision only observes and cannot overwrite memory-derived state or actions.
Each remote provider uses its selected service's credentials and account credits.
Model settings are independent:

| Environment setting | Used by | Default |
| --- | --- | --- |
| `TYPESAFE_MODEL` | Direct TypeSafe decisions | `jev-latest` |
| `JEV_MODEL` | Gateway decisions | `typesafe-ai/jev` |
| `VISION_MODEL` | Gateway vision | `google/gemini-2.5-flash` |

Only selected providers validate their credentials and model settings. Direct
TypeSafe ignores `JEV_MODEL`; disabled and mock vision ignore `VISION_MODEL`.
Direct TypeSafe records the actual model ID returned by the API. Gateway model
names use its provider/model format, and the visual model must accept images.

## Observation and game readers

The original demo and the verified English Pokémon Red, Blue, and Yellow
revisions have automatically selected memory readers. To use only Jev:

```sh
npm start -- --demo --agent gateway --vision none --goal "Increase scrollX"
npm start -- --rom "roms/pokemon-red.gb" --agent typesafe --vision none --goal "Choose a starter Pokemon"
npm start -- --rom "roms/my-game.gb" --profile "my-reader" --agent typesafe --vision none --goal "Complete the first level"
```

State-only mode requires a compatible reader. Arbitrary games have different
memory layouts; emulator metadata alone cannot reveal menus, health, player
positions, or valid gameplay choices. Readers follow the `GameReader` Strategy
contract and registry. See [adding a game reader](game-readers.md) and the
working [demo strategy](../src/profiles/demo.ts). Simple layouts can use a
[JSON profile](../examples/demo-profile.json) without implementing another class.
See [Pokémon readers](pokemon-readers.md) for the supported hashes,
decoded fields, limits, and extending the shared Gen I reader to other revisions.
### Pokémon support

They also expose named inventory, ordinary capture-ball counts, team-preparation
facts and explicit capture/Mart item choices. A profile-local preparation layer
explains HP percentages, status, live party PP/max PP, the upcoming recognized
leader's ROM-derived team and usable attack matchups. Jev can choose capture
from a city without balls, buy supplies as part of that purpose, then follow
walking-area guidance to known land encounters. Center healing still requires
the selected nurse interaction and observed HP/status/PP recovery.
After a battle, any member at 50% HP or less prompts healing reconsideration.
Priority facts and action descriptions favor nearby verified pickups and every
eligible wild species absent from the team, regardless of Pokedex ownership or
shared types. Missing balls prioritize Mart supplies; urgent healing comes first.
Eligible captures first request one cautious weakening move when its ordinary
and critical estimates leave the target alive, then reassess HP. Gen I HP benefit
plateaus near 33% for Poke/Ultra Balls and 50% for Great Balls, with exact integer
rounding. Jev switches to balls at a plateau or earlier when further damage risks
a KO or cannot be estimated cautiously. The reader supplies per-ball capture
estimates and per-move HP risk; each attack and throw still requires Jev's choice.
Verified party lists identify Pokemon by slot, species and HP even when nicknames
repeat, and offer explicit switching choices. Naming screens offer complete unique
names; add a standalone `Pokemon names: EMBER, WING, LEAF` line to objective
constraints or milestones to suggest names. Jev selects the name to type.
Mart advice includes small affordable Potion/Antidote reserves. Jev can open the
bag, choose a suitable medicine and select its party recipient during or after
battle; USE, purchase quantity and price confirmations remain separate choices.
Antidotes cure poison; Potions restore HP. Neither restores PP or revives fainted
members. Existing edited objectives are preserved; **Use game defaults** reloads
the updated suggestions in Settings.
An immediate reader-owned decision task distinguishes the current battle from
future preparation. Known exhausted stat effects and ordinary type immunity are
withheld when another known usable move exists; Jev can select a move directly
from FIGHT or attempt RUN in a normal wild battle. Long walking actions yield
when a new verified pickup becomes nearby, so Jev can reconsider before passing it.
Jev chooses a bag or ball slot;
shop item selection leaves quantity and price confirmation to later decisions.
Visible pickups are distinguished from starter sprites using cartridge object
flags. Early supply-route facts can guide a detour to Viridian/Pewter Mart when
balls are missing. Custom objectives remain authoritative; use **Settings →
Agent → Objectives → Use game defaults** to review the expanded preparation
constraints. These facts do not establish live team-building competence.
Pokémon readers also supply profile-owned decision facts: live walking collision,
objects/signs, exits, and local route distances with the first available inputs.
They retain bounded recent text from completed conversations and warn when A
would restart an interaction from the same position/facing without an observed
change in tracked game state. This evidence does not automatically exclude
repeat conversations or choose a destination.
Adjacent entries for the same doorway share a route. Facing-edge exits describe
the required outward input, so standing on a mat is not mistaken for completing
the transition. Automatic stairs and special warp rules retain their own checks.
Jev can select a destination action to walk to an exit or approach and interact
with an object/sign. The profile executor retains that destination for up to
600 frames, settling movement locally and stopping for interruptions, changed
maps, or an unavailable route. It then returns control to Jev. Static walking
regions and exact door landing coordinates distinguish disconnected areas of
the same map when describing travel toward the active recognized checkpoint.
Repeated partial approaches retain failed-attempt evidence; bounded map-crossing
memory warns about immediate return loops even after long battles.
After receiving the Pokedex, Jev first chooses a persistent purpose such as
story progress, shopping or healing. It survives map changes; relevant people
and exits are labelled against it, and arrival is separate from performing the
task. Six actions without a new best route distance require reconsideration;
repeated attempt evidence survives that review. Jev still chooses every purpose
and controller action. This reduces conflicting destination choices and does
not guarantee that the model will never repeat an unhelpful choice.
Surfing and special field mechanics remain partial; decoded routes do not prove
quest progress or full-game competence.

Open **Game state** in manual or agent mode to inspect live fields,
descriptions, and available actions. `GET /api/game-state` exposes the same
read-only snapshot. This makes no model calls and does not advance the emulator.

## Provider APIs

Jev accepts text-based state, so screenshots go to a separate visual model.
Direct decisions use TypeSafe's documented [System One API](https://docs.typesafe.ai/api).
Gateway decisions use its [evaluation HTTP API](https://vercel.com/docs/ai-gateway/modalities/evaluation),
and Gateway vision uses its [chat completions API](https://vercel.com/docs/ai-gateway/sdks-and-apis/openai-chat-completions).
The adapters normalize the different confidence and token-usage fields into the
same decision contract and validate selected actions and probability distributions.
Native Node `fetch` avoids an additional SDK dependency; Apache-2.0 SDK code
would be incompatible with the emulator's GPL-2.0-only license.

## Decision execution and history

The viewer keeps emulation and sound running while models respond, with one
request pipeline at a time. Decisions use a snapshot and local action availability
is checked again before execution. Generic actions hold one button or a direction with A/B for a bounded
duration, then release for four frames; readers can supply other valid button combinations.
The `wait` action advances without input; buttons are also released during model
requests. Model latency delays the next controller input while the game continues.
This loop is best suited to games that tolerate discrete control rather than fast reactions.
Optional profile actions emit validated mechanical steps toward a model-selected
target, within their frame ceiling plus four release frames. Optional local
settling skips both model providers for up to 600 neutral frames between requests;
it then asks again even if the game still reports busy. No alternative destination
or recovery action is selected by the runtime.

Readers can attach a semantic context key to actions. The Pokemon readers use
it to discard a delayed A intended to advance dialogue if that conversation
has already closed. The game continues while a fresh decision is requested;
the obsolete response is recorded and still counts toward session ceilings.

Recent history includes `result` for completed actions: execution-end frame,
screen/state change flags, and up to 12 changed fields with bounded before/after
values. Jev also receives `feedback` over up to 32 observations: recurring states,
consecutive unchanged states/actions, repeated action cycles, and fields that
remained stable across recent observations. Opening and closing a menu does not
erase visits to the same earlier state. These are observed changes, not verified
progress or collision information; Jev still selects every offered gameplay action.
Destination executions also record their completion/interruption reason.
Jev requests avoid duplicating memory state in the observation string and shorten
historical observation text while retaining structured evidence and action results.

## Offline mock sessions

To test the entire controller loop without keys, network access, or costs:

```sh
npm run agent:demo
npm run agent:demo -- --headless --decisions 10 --screenshot "output/agent-demo.png"
```

The mock decision provider cycles through predetermined inputs. The demo still
uses its real local memory reader and state-dependent action availability. Mock
decisions do not demonstrate Jev's gameplay ability. To test composition with
mock vision, still without keys or API calls:

```sh
npm start -- --demo --agent mock --vision mock --goal "Inspect the screen"
```

Mixing providers is useful for testing each layer separately. A mock decision
provider with `--vision gateway` makes real, potentially billable vision requests;
a live Jev provider with `--vision mock` still makes Jev requests. Mock vision
returns fixed descriptions and does not interpret the screenshots.

## Objectives and limits

For a goal with constraints and milestones, edit
[`examples/objectives.json`](../examples/objectives.json) and use it instead of
`--goal`:

```sh
npm start -- --rom "roms/my-game.gb" --agent gateway --objectives "examples/objectives.json"
npm start -- --rom "roms/my-game.gb" --agent gateway --goal "Reach gameplay" --headless --decisions 20 --save "saves/agent.json"
```

| Option | Default | Meaning |
| --- | --- | --- |
| `--decisions` | 100 | Maximum accepted Jev choices |
| `--requests` | 300 | Jev and optional vision HTTP attempts, including failures, retries, and cancellations |
| `--max-seconds` | 300 | Wall-clock session limit, including viewer pauses |
| `--action-frames` | 24 | Input duration; held inputs also get 4 release frames |
| `--frames` | 1,000,000 in agent mode | Additional headless frame limit |

Agent ceilings accept `unlimited` instead of a number. **Settings → Agent** also
lets you edit objectives, constraints, milestones, action duration, and the three
session ceilings while the viewer is running. Choose **Objectives** or **Limits**
in the editor; enter one constraint or milestone per line. Leave a ceiling blank
to disable it individually, or select **No session limits** to disable all three.
Use **Apply changes**, close Settings, and **Resume**. Saving pauses the agent,
interrupts active inputs, and cancels pending observations/decisions so that the
next request uses the new objective and action set. Profiles can still choose
their own bounded action durations. Changes are recorded in the local JSONL log;
the objectives file and browser storage are not rewritten.

Readers may supply default objectives, constraints, and milestones. The Pokemon
readers preload 16 editable story milestones, with separate starter guidance
for Yellow. **Use game defaults** restores those fields in the draft without
changing session ceilings; apply the draft to activate it. CLI `--goal` or
`--objectives` takes precedence. Either flag can be omitted in agent mode when
the selected reader supplies defaults. Other games still need a user objective.
The Pokemon profile recognizes supplied default milestone text and exposes the
first pending checkpoint, its destination, and `completedStoryChecks` using named
event flags, badges, inventory, and an explicit Lavender arrival check. Custom
milestones remain unverified. Checkpoints do not verify every sentence in the
guidance or the whole objective; see [criteria and limits](pokemon-readers.md#editable-story-objectives).

The **?** beside each setting explains its behavior. Hover, focus the help button
with the keyboard, or tap it to read the tooltip. Press Escape or tap elsewhere
to dismiss it. Agent help describes shared request counts, elapsed time during
pauses, action durations, and the difference between guidance and verified progress.

For a session without decision, request, or time ceilings from startup:

```sh
npm start -- --rom "roms/my-game.gb" --agent typesafe --vision none --goal "Finish the game" --unlimited
```

`--unlimited` also removes the default headless frame ceiling. An explicit
`--frames <count>` still applies; headless agent runs can alternatively use
`--frames unlimited`. Individual `--decisions unlimited`, `--requests unlimited`,
and `--max-seconds unlimited` flags leave the other ceilings in place. Keep
`--unlimited` separate from those three individual options.

Unlimited sessions still honor pause, Ctrl+C, provider failures, and Jev's
explicit stop action. HTTP timeouts, retry bounds, action bounds, history sizes,
and recording caps remain in effect. A stop chosen by Jev is **unverified
completion**: no current reader verifies that the whole game has been finished.

Requests have a 20-second timeout and a shared minimum interval of 250 ms.
HTTP 429 and server errors retry once with bounded backoff. Authentication,
malformed responses, and unlisted actions stop the session without fallback
inputs. These are request and execution limits, not a currency budget; requests
already accepted by a provider may be billed even if cancelled. Gateway's own
upstream routing is outside the application's attempt counter.

Stopping at a limit leaves the viewer open for inspection. Increase or disable
the reached ceiling in **Settings → Agent** and apply the changes to continue
from the current emulator state. Applying settings can also reopen a session
after a Jev stop or provider error; it remains paused until you explicitly resume.
Decision/request counters and elapsed time are retained. Time ceilings are total
seconds since session startup, including pauses, rather than a new countdown
after each edit. A ceiling below already consumed counts or time keeps the
session stopped. Load a ROM or start a new process for fresh counters. Reset and restore clear
visual/action history and discard pending responses while retaining the current
session's counters. Checkpoints restore emulator state; they do not restore agent
history, edited settings, or provider budgets.
Milestone text and a model-selected `stop` are not independently verified evidence
of completion. Profile checkpoint checks can provide narrower game evidence;
the session's full-objective completion status remains unverified.

## Session records and diagnostics

Each agent run writes a local JSONL record under `logs/sessions/`: objectives,
selected provider IDs, candidate actions, observations, model choices and usage,
actual frame ranges, interrupted actions, and stop reasons. API keys and provider error bodies are
excluded. Records may contain game text and user objectives; keep them local.
The same file includes timestamped diagnostics for the agent, game reader,
Jev validation, and HTTP attempts, including failed decisions. Reader snapshots
are recorded when fields or available actions change. Reset and restore clear
that comparison, so the next read is recorded again. Each log keeps a rolling
window of recent events within 32 MiB. When full, it removes the oldest complete
JSONL lines in batches, freeing at least a quarter of the window before adding
the latest event. Retained events remain in chronological order in the same
file; the initial session details can eventually be evicted. A single terminal
notice announces the first eviction; recording and gameplay continue. An event
larger than the whole window is replaced by a bounded `log-event-omitted` marker;
subsequent events are still recorded.

Add **`--debug`** to print these diagnostics in the terminal too. Without it,
only diagnostic warnings and errors are printed. Manual play also creates a
local diagnostic record when `--debug` is enabled. Each record wraps an `event`
with an ISO `at` timestamp; diagnostic events have `type: "diagnostic"`,
`component`, `level`, `event`, an optional emulator `frame`, and structured
`data`. Use the frame, decision sequence, and model request number to correlate
reader output, the candidate actions sent to Jev, and the returned distribution.
No raw HTTP response bodies, authentication headers, or screenshots are logged.

```sh
npm start -- --rom "roms/my-game.gb" --agent typesafe --vision none --goal "Earn the first badge" --debug
```

### Probability diagnostics

An `action-distribution` diagnostic keeps the probabilities as returned, their
sum, the allowed rounding tolerance, and the selected and highest probabilities.
For direct TypeSafe responses on a two-decimal grid, the sum check allows half a
hundredth per option, capped at 0.05. This handles the rounded probabilities
observed in local sessions; higher-precision responses retain the stricter check.
Zero distributions, missing or invalid probabilities, and unlisted choices
still stop the session. The
[TypeSafe Choice contract](https://docs.typesafe.ai/api#choice-answer) identifies
`choice` as the highest-probability option. Direct responses observed locally
have sometimes selected a listed action with a lower returned probability.
The runtime treats the explicit `choice` as Jev's gameplay decision, preserves
it, and records a `choice-probability-mismatch` warning when the distribution
ranks another action higher. It does not replace the choice with an argmax or
make another model request. Probability values are recorded without normalizing
them. Current action availability and frame bounds are always enforced.

Live state-only mode sends structured state to the selected Jev service. Gateway
vision additionally sends screenshots to its visual model; mock vision runs
locally. ROM binaries and checkpoints stay on your machine. Reader-specific
memory meanings are not guessed for unsupported ROMs.
