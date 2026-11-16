// Procedural WebAudio sound effects: every noise the game makes is synthesised from
// oscillators and filtered noise — no audio files, nothing to load. M toggles mute.

export function createAudio() {
  let context = null;
  let master = null;
  let noiseBuffer = null;
  let muted = false;

  /** Browsers only let audio start after a gesture; call this from clicks and keys. */
  function unlock() {
    if (context) {
      if (context.state === 'suspended') void context.resume();
      return;
    }
    const AudioCtor = window.AudioContext ?? window.webkitAudioContext;
    if (!AudioCtor) return;
    context = new AudioCtor();
    master = context.createGain();
    master.gain.value = 0.32;
    master.connect(context.destination);
    const length = context.sampleRate * 0.5;
    noiseBuffer = context.createBuffer(1, length, context.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < length; i += 1) data[i] = Math.random() * 2 - 1;
  }

  function tone({ type = 'sine', from = 440, to = from, seconds = 0.12, volume = 0.5, delay = 0 }) {
    if (!context || muted) return;
    const start = context.currentTime + delay;
    const osc = context.createOscillator();
    const gain = context.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(from, start);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), start + seconds);
    gain.gain.setValueAtTime(volume, start);
    gain.gain.exponentialRampToValueAtTime(0.001, start + seconds);
    osc.connect(gain).connect(master);
    osc.start(start);
    osc.stop(start + seconds + 0.02);
  }

  function noise({ seconds = 0.2, volume = 0.5, frequency = 1200, delay = 0 }) {
    if (!context || muted) return;
    const start = context.currentTime + delay;
    const source = context.createBufferSource();
    source.buffer = noiseBuffer;
    source.loop = true;
    const filter = context.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(frequency, start);
    filter.frequency.exponentialRampToValueAtTime(80, start + seconds);
    const gain = context.createGain();
    gain.gain.setValueAtTime(volume, start);
    gain.gain.exponentialRampToValueAtTime(0.001, start + seconds);
    source.connect(filter).connect(gain).connect(master);
    source.start(start);
    source.stop(start + seconds + 0.02);
  }

  return {
    unlock,
    get muted() {
      return muted;
    },
    toggleMute() {
      muted = !muted;
      return muted;
    },
    shoot() {
      tone({ type: 'square', from: 880, to: 320, seconds: 0.07, volume: 0.16 });
    },
    hit() {
      noise({ seconds: 0.06, volume: 0.2, frequency: 2600 });
    },
    explosion(big = false) {
      noise({ seconds: big ? 0.5 : 0.25, volume: big ? 0.7 : 0.4, frequency: big ? 900 : 1400 });
      tone({ type: 'sine', from: big ? 160 : 220, to: 40, seconds: big ? 0.5 : 0.28, volume: 0.5 });
    },
    pickup() {
      tone({ type: 'sine', from: 660, to: 1180, seconds: 0.09, volume: 0.22 });
    },
    hurt() {
      tone({ type: 'sawtooth', from: 300, to: 70, seconds: 0.25, volume: 0.45 });
      noise({ seconds: 0.18, volume: 0.3, frequency: 700 });
    },
    coreHurt() {
      tone({ type: 'triangle', from: 190, to: 60, seconds: 0.3, volume: 0.5 });
    },
    bossWarn() {
      tone({ type: 'sawtooth', from: 130, to: 98, seconds: 0.32, volume: 0.4 });
      tone({ type: 'sawtooth', from: 130, to: 98, seconds: 0.32, volume: 0.4, delay: 0.38 });
    },
    waveStart() {
      tone({ type: 'triangle', from: 392, seconds: 0.12, volume: 0.3 });
      tone({ type: 'triangle', from: 587, seconds: 0.16, volume: 0.3, delay: 0.11 });
    },
    upgrade() {
      tone({ type: 'sine', from: 523, seconds: 0.1, volume: 0.3 });
      tone({ type: 'sine', from: 659, seconds: 0.1, volume: 0.3, delay: 0.08 });
      tone({ type: 'sine', from: 784, seconds: 0.18, volume: 0.34, delay: 0.16 });
    },
    gameOver() {
      tone({ type: 'sawtooth', from: 220, to: 55, seconds: 0.9, volume: 0.4 });
      noise({ seconds: 0.8, volume: 0.3, frequency: 500 });
    },
  };
}
