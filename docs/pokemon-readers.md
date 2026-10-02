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
| `menuCursorX`, `menuCursorY`, `menuCursorRow` | Visible boxed cursor position and its row; not a claim that the game is polling input |
| `namingPrompt`, `enteredName` | Player/rival naming heading and current entry when the naming alphabet grid is visible |
| `playerName`, `rivalName` | Terminated, decoded names after gameplay starts |
| `mapId`, `playerX`, `playerY`, `mapWidth`, `mapHeight`, `facing`, `movementMode` | Location and movement state; map dimensions use movement squares |
| `money`, `badgeCount`, `badges`, `pokedexOwned`, `pokedexSeen` | Packed-BCD money, badge flags, and 151-species bit counts |
| `bagCount`, `bagItems` | Occupied bag slots and internal item ID/quantity pairs |
| `partyCount`, `party1` through `party6`, corresponding `Moves` fields | Nicknames, internal species IDs, levels, big-endian HP, types, status, and move IDs/PP |
| `battleKind`, `battleType`, `battlePlayer`, `battlePlayerMoves`, `battleEnemy` | Active battle data, including current HP and normal/demo/Safari variant |

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
Item and move IDs are not translated using a bundled game-data table. Names
visible in boxed menus remain available as text; a nickname need not identify
its species.

Actions retain stable controller IDs such as `press_a` and `press_down`, with
context descriptions. Button presses use at most eight frames, or a shorter
`--action-frames` setting, followed by four release frames. Waits retain the
configured duration. Simultaneous button combinations are excluded. LCD-off
and blocked overworld transitions offer only `wait` and `stop`. Other phases
offer single-button attempts: a control can do nothing if the current screen
ignores it. The reader does not claim to enumerate every legal in-game command
or exclude every ineffective input. Jev selects all gameplay inputs; the reader
never chooses moves, walks a route, or executes a walkthrough.

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
[`red.ts`](../src/profiles/pokemon/red.ts),
[`blue.ts`](../src/profiles/pokemon/blue.ts), and
[`yellow.ts`](../src/profiles/pokemon/yellow.ts) supply each exact revision.
Red and Blue use [`red-blue-layout.ts`](../src/profiles/pokemon/red-blue-layout.ts);
Yellow supplies its own explicitly checked addresses. Do not apply a uniform
offset to all Red addresses: Yellow's tile-map and sprite fields retain their
addresses while many later fields move. These modules stay under `src/profiles/`;
the core, Jev adapters, vision adapters, and runner contain no Pokémon knowledge.
Reads take a fresh
bounded RAM snapshot without writes, frame advancement, or caches.

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

The reader is an original implementation using documented layout facts; no
disassembly code or commercial assets are copied. Automated tests use invented
RAM and blank frames for each release, including party/battle decoding, startup
guards, bounded actions, cross-version rejection, restore/reset, and memory-only
sessions. Local checks with the matching ROMs exercised startup, intro, naming,
the starting room, overworld menus, restore/reset, and memory-only decision
execution. Party/battle decoding is covered by synthetic fixtures; full-game
play and live Jev performance have not been verified. Yellow-specific follower
behavior and Pikachu's happiness are not decoded by the shared reader.

These readers supply observations, not a complete Pokémon agent. They have
no collision map, NPC or exit model, pathfinding, event-flag objectives, or
verified completion checks. Vision can supplement missing visible evidence.
Loading the ROM and decoding state do not establish that Jev will finish it.
