// Procedural sound: every effect is synthesised with WebAudio at the moment it is needed —
// filtered noise for gunfire, square blips for the charge, a low boom for the detonation.
// No audio files, so nothing to load and nothing to fetch. The context is created lazily on
// the first user gesture (the click that starts the match), as browsers require.

let ctx = null;
let master = null;

export function initAudio() {
  if (ctx) {
    if (ctx.state === 'suspended') ctx.resume();
    return;
  }
  const AudioCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtor) return;
  ctx = new AudioCtor();
  master = ctx.createGain();
  master.gain.value = 0.5;
  master.connect(ctx.destination);
}

function noiseBuffer(seconds) {
  const buffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * seconds), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;
  return buffer;
}

function burst({ at = 0, dur = 0.12, freq = 1800, gain = 0.5, type = 'lowpass', sweepTo = 0 }) {
  if (!ctx) return;
  const t0 = ctx.currentTime + at;
  const source = ctx.createBufferSource();
  source.buffer = noiseBuffer(dur);
  const filter = ctx.createBiquadFilter();
  filter.type = type;
  filter.frequency.setValueAtTime(freq, t0);
  if (sweepTo) filter.frequency.exponentialRampToValueAtTime(sweepTo, t0 + dur);
  const amp = ctx.createGain();
  amp.gain.setValueAtTime(gain, t0);
  amp.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  source.connect(filter).connect(amp).connect(master);
  source.start(t0);
  source.stop(t0 + dur + 0.02);
}

function tone({ at = 0, dur = 0.09, freq = 880, gain = 0.16, type = 'square', slideTo = 0 }) {
  if (!ctx) return;
  const t0 = ctx.currentTime + at;
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
  const amp = ctx.createGain();
  amp.gain.setValueAtTime(gain, t0);
  amp.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  osc.connect(amp).connect(master);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

export const sfx = {
  shot(kind) {
    if (kind === 'longbow') burst({ dur: 0.28, freq: 900, gain: 0.65, sweepTo: 120 });
    else if (kind === 'breach12') burst({ dur: 0.22, freq: 700, gain: 0.6, sweepTo: 150 });
    else burst({ dur: 0.11, freq: 2100, gain: 0.38, sweepTo: 500 });
  },
  dryFire() { tone({ dur: 0.04, freq: 1400, gain: 0.08 }); },
  reload() {
    tone({ at: 0, dur: 0.05, freq: 500, gain: 0.1, type: 'square' });
    tone({ at: 0.18, dur: 0.05, freq: 700, gain: 0.1, type: 'square' });
    tone({ at: 0.36, dur: 0.06, freq: 950, gain: 0.12, type: 'square' });
  },
  hit(head) {
    tone({ dur: 0.05, freq: head ? 1560 : 1180, gain: 0.14, type: 'sine' });
  },
  kill() {
    tone({ dur: 0.09, freq: 660, gain: 0.14, type: 'sine' });
    tone({ at: 0.07, dur: 0.12, freq: 990, gain: 0.14, type: 'sine' });
  },
  hurt() { burst({ dur: 0.09, freq: 500, gain: 0.22 }); },
  plantBeep(final) {
    tone({ dur: final ? 0.3 : 0.07, freq: final ? 1320 : 1040, gain: 0.13 });
  },
  explosion() {
    burst({ dur: 1.1, freq: 3000, gain: 0.9, sweepTo: 60 });
    tone({ dur: 0.7, freq: 90, gain: 0.5, type: 'sine', slideTo: 34 });
  },
  defused() {
    tone({ dur: 0.1, freq: 780, gain: 0.13 });
    tone({ at: 0.1, dur: 0.16, freq: 1170, gain: 0.13 });
  },
  roundWin() {
    tone({ dur: 0.12, freq: 523, gain: 0.12, type: 'triangle' });
    tone({ at: 0.11, dur: 0.12, freq: 659, gain: 0.12, type: 'triangle' });
    tone({ at: 0.22, dur: 0.2, freq: 784, gain: 0.13, type: 'triangle' });
  },
  roundLose() {
    tone({ dur: 0.14, freq: 392, gain: 0.12, type: 'triangle' });
    tone({ at: 0.13, dur: 0.22, freq: 311, gain: 0.12, type: 'triangle' });
  },
  buy() { tone({ dur: 0.06, freq: 1250, gain: 0.1, type: 'sine' }); },
  flash() { tone({ dur: 0.5, freq: 3400, gain: 0.1, type: 'sine', slideTo: 2800 }); },
  throw_() { burst({ dur: 0.06, freq: 1200, gain: 0.1 }); },
};
