/** Plays streamed PCM with a bounded queue, without requiring a worklet or plugin. */
export class AudioPlayer {
  enabled = false;
  paused = true;
  volume = 0.35;
  generation = 0;
  epoch = -1;
  context = null;
  gain = null;
  nextTime = 0;
  sources = new Set();
  fresh = true;

  async enable() {
    if (!this.context) {
      const AudioContext = globalThis.AudioContext ?? globalThis.webkitAudioContext;
      if (!AudioContext) throw new Error("This browser does not support game audio.");
      this.context = new AudioContext({ latencyHint: "interactive" });
      // The legacy APU output contains a DC offset; remove it before playback.
      const filter = this.context.createBiquadFilter();
      filter.type = "highpass";
      filter.frequency.value = 20;
      this.gain = this.context.createGain();
      this.gain.connect(filter);
      filter.connect(this.context.destination);
    }
    await this.context.resume();
    if (this.context.state !== "running") throw new Error("Click Enable sound to allow audio playback.");
    this.enabled = true;
    this.setVolume(this.volume);
    this.reset();
  }

  mute() {
    this.enabled = false;
    this.reset();
  }

  setVolume(volume) {
    this.volume = Math.max(0, Math.min(1, volume));
    if (this.gain) this.gain.gain.value = this.volume;
  }

  setPaused(paused) {
    if (this.paused !== paused) this.reset();
    this.paused = paused;
  }

  reset() {
    this.generation++;
    for (const source of this.sources) { source.stop(); source.disconnect(); }
    this.sources.clear();
    this.nextTime = 0;
    this.fresh = true;
  }

  play(samples, sampleRate, channels, speed, epoch, paused) {
    if (epoch < this.epoch) return;
    if (epoch !== this.epoch) { this.reset(); this.epoch = epoch; }
    this.setPaused(paused);
    if (!this.enabled || paused || this.context?.state !== "running") return;
    // Drop the first packet after a discontinuity so old samples cannot replay.
    if (this.fresh) { this.fresh = false; return; }
    if (!samples.length) return;
    if (![1, 2].includes(channels) || samples.length % channels !== 0 ||
        !Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 192000 ||
        !Number.isFinite(speed) || speed <= 0 || speed > 32) throw new Error("Invalid game audio packet.");
    if (this.nextTime > this.context.currentTime + 0.2) this.reset();
    const buffer = this.context.createBuffer(channels, samples.length / channels, sampleRate);
    for (let channel = 0; channel < channels; channel++) {
      const data = buffer.getChannelData(channel);
      for (let index = 0; index < data.length; index++) data[index] = samples[index * channels + channel];
    }
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = speed;
    source.connect(this.gain);
    source.onended = () => { this.sources.delete(source); source.disconnect(); };
    this.sources.add(source);
    const start = Math.max(this.nextTime, this.context.currentTime + 0.06);
    source.start(start);
    this.nextTime = start + buffer.duration / speed;
  }
}
