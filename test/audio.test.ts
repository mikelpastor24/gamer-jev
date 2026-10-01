import assert from "node:assert/strict";
import { test } from "node:test";
import { createDemoRom } from "../src/demo/rom.js";
import { GameBoyEmulator } from "../src/emulator/game-boy/game-boy-emulator.js";
import type { ServerboySnapshot } from "../src/emulator/game-boy/serverboy.js";

test("the real APU produces bounded stereo PCM from the original test tone", () => {
  const emulator = new GameBoyEmulator(createDemoRom());
  try {
    emulator.advance({ buttons: [], frames: 30 });
    const audio = emulator.drainAudio();
    assert.equal(audio.channels, 2);
    assert.ok(audio.sampleRate > 44000 && audio.sampleRate < 44200);
    assert.ok(audio.samples.length > 0);
    assert.ok(audio.samples.length / audio.channels <= Math.ceil(audio.sampleRate * 0.25));
    assert.equal(audio.samples.length % 2, 0);
    let minimum = 1;
    let maximum = -1;
    for (let index = 0; index < audio.samples.length; index += 2) {
      const sample = audio.samples[index]!;
      assert.ok(Number.isFinite(sample) && sample >= -1 && sample <= 1);
      assert.equal(sample, audio.samples[index + 1]);
      minimum = Math.min(minimum, sample);
      maximum = Math.max(maximum, sample);
    }
    assert.ok(maximum - minimum > 0.1, "The tone must vary, rather than contain only silence or a DC offset.");
    const middle = (minimum + maximum) / 2;
    let cycles = 0;
    for (let index = 2; index < audio.samples.length; index += 2) {
      if (audio.samples[index - 2]! < middle && audio.samples[index]! >= middle) cycles++;
    }
    const frequency = cycles * audio.sampleRate / (audio.samples.length / 2);
    assert.ok(frequency > 430 && frequency < 450, `Expected a 440 Hz tone, received ${frequency} Hz.`);
    assert.equal(emulator.drainAudio().samples.length, 0);
    emulator.advance({ buttons: [], frames: 1 });
    assert.ok(emulator.drainAudio().samples.length > 0);
  } finally { emulator.dispose(); }
});

test("restoring an audio checkpoint reproduces its PCM phase and clears stale samples", () => {
  const emulator = new GameBoyEmulator(createDemoRom());
  try {
    emulator.advance({ buttons: [], frames: 7 });
    emulator.drainAudio();
    const checkpoint = JSON.parse(JSON.stringify(emulator.saveState())) as unknown;
    emulator.advance({ buttons: [], frames: 4 });
    const expected = emulator.drainAudio().samples;
    emulator.advance({ buttons: [], frames: 2 });
    emulator.restoreState(checkpoint);
    assert.equal(emulator.drainAudio().samples.length, 0);
    emulator.advance({ buttons: [], frames: 4 });
    assert.deepEqual(emulator.drainAudio().samples, expected);
    emulator.reset();
    assert.equal(emulator.drainAudio().samples.length, 0);
  } finally { emulator.dispose(); }
});

test("checkpoints without audio phase remain usable and invalid audio phase is rejected", () => {
  const emulator = new GameBoyEmulator(createDemoRom());
  try {
    emulator.advance({ buttons: [], frames: 5 });
    const state = emulator.saveState();
    const { audioPhase: _audioPhase, ...legacyPayload } = state.payload as ServerboySnapshot;
    emulator.restoreState({ ...state, payload: legacyPayload });
    emulator.advance({ buttons: [], frames: 1 });
    assert.ok(emulator.drainAudio().samples.length > 0);
    assert.throws(() => emulator.restoreState({ ...state, payload: {
      ...legacyPayload, audioPhase: { index: -1, ticks: 0, accumulator: 0 },
    } }), /audio phase/);
  } finally { emulator.dispose(); }
});
