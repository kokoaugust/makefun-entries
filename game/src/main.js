// Boot and wiring: canvas, input, audio, the fixed-step loop, screen transitions from
// clicks and keys, and the ?shot= screenshot mode the maker captures with. All rules live
// in world.js; this file only connects the world to the page.

import { STEP, VIEW_HEIGHT, VIEW_WIDTH } from './config.js';
import { createInput } from './input.js';
import { createAudio } from './audio.js';
import { createWorld, SCREEN_OVER, SCREEN_PLAY, SCREEN_TITLE, SCREEN_UPGRADE } from './world.js';
import { drawScene, upgradeCardAt } from './render.js';
import { stageWorld } from './shots.js';

const canvas = document.getElementById('game');
canvas.width = VIEW_WIDTH;
canvas.height = VIEW_HEIGHT;
const ctx = canvas.getContext('2d');

const params = new URLSearchParams(window.location.search);
const shotName = params.get('shot');
const seedParam = Number.parseInt(params.get('seed') ?? '', 10);
const seed = Number.isFinite(seedParam) ? seedParam : (Date.now() % 2147483647);

const input = createInput(canvas);
const audio = createAudio();
const world = shotName ? stageWorld(shotName, seed) : createWorld(seed);
const ui = { best: 0, muted: false, shot: Boolean(shotName) };

const SOUND_FOR_EVENT = {
  shoot: 'shoot',
  hit: 'hit',
  pickup: 'pickup',
  hurt: 'hurt',
  coreHurt: 'coreHurt',
  shieldHit: 'hit',
  waveStart: 'waveStart',
  bossWarn: 'bossWarn',
  upgrade: 'upgrade',
  gameOver: 'gameOver',
};
const lastPlayed = new Map();

function drainEvents() {
  const now = performance.now();
  for (const event of world.state.events) {
    if (event.name === 'explosion') {
      audio.explosion(event.big);
      continue;
    }
    const method = SOUND_FOR_EVENT[event.name];
    if (!method) continue;
    const last = lastPlayed.get(method) ?? -1000;
    if (now - last < 45) continue;
    lastPlayed.set(method, now);
    audio[method]();
  }
  world.state.events.length = 0;
}

function handleScreenInput() {
  const { state } = world;
  if (state.screen === SCREEN_TITLE) {
    if (input.mouseClicked || input.pressed.has('Enter')) {
      audio.unlock();
      world.startRun();
    }
  } else if (state.screen === SCREEN_OVER) {
    if (input.mouseClicked || input.pressed.has('Enter')) {
      audio.unlock();
      world.startRun();
    }
  } else if (state.screen === SCREEN_UPGRADE) {
    if (input.mouseClicked) {
      const index = upgradeCardAt(input.mouseX, input.mouseY);
      if (index >= 0) world.chooseUpgrade(index);
    }
    for (let i = 0; i < 3; i += 1) {
      if (input.pressed.has(`Digit${i + 1}`) || input.pressed.has(`Numpad${i + 1}`)) {
        world.chooseUpgrade(i);
      }
    }
  } else if (state.screen === SCREEN_PLAY) {
    if (input.pressed.has('KeyP') || input.pressed.has('Escape')) {
      state.paused = !state.paused;
    }
  }
  if (input.pressed.has('KeyM')) {
    ui.muted = audio.toggleMute();
  }
  if (input.pressed.has('Enter') || input.mouseClicked) audio.unlock();
}

let shotControl = null;
if (shotName) {
  document.body.classList.add('shot');
  world.state.events.length = 0;
  shotControl = { moveX: 0, moveY: 0, aimX: world.state.player.x, aimY: 0, firing: false };
}

let last = performance.now();
let accumulator = 0;
let framesRendered = 0;

function frame(now) {
  requestAnimationFrame(frame);
  let dt = (now - last) / 1000;
  last = now;
  if (dt > 0.25) dt = 0.25;
  accumulator += dt;

  handleScreenInput();

  const control = shotName
    ? shotControl
    : {
        moveX: input.moveX,
        moveY: input.moveY,
        aimX: input.mouseX,
        aimY: input.mouseY,
        firing: input.firing && world.state.screen === SCREEN_PLAY && !world.state.paused,
      };

  while (accumulator >= STEP) {
    world.step(STEP, control);
    accumulator -= STEP;
  }
  drainEvents();
  if (world.state.screen === SCREEN_OVER) {
    ui.best = Math.max(ui.best, world.state.score);
  }
  drawScene(ctx, world, ui);
  input.endFrame();
  framesRendered += 1;
  if (shotName && framesRendered >= 4) {
    window.__shotReady = true;
  }
}
requestAnimationFrame(frame);
