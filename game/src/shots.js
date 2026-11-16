// Deterministic screenshot scenes behind ?shot=title|play|upgrade|over&seed=N. Each scene
// drives the real world with a scripted pilot at the fixed step, so the frame is a genuine
// moment of the game and the same seed always stages the same frame. The play scene is
// staged in two passes over the same seed: the first finds the busiest moment of a
// scripted run (most hostiles and shots on screen), the second replays to that moment.

import { CORE_X, CORE_Y, STEP } from './config.js';
import { createWorld, SCREEN_OVER, SCREEN_PLAY, SCREEN_UPGRADE } from './world.js';

const IDLE = { moveX: 0, moveY: 0, aimX: CORE_X, aimY: 0, firing: false };

function nearestEnemy(state) {
  let target = null;
  let best = Infinity;
  for (const e of state.enemies) {
    const d = Math.hypot(e.x - state.player.x, e.y - state.player.y);
    if (d < best) {
      best = d;
      target = e;
    }
  }
  return target;
}

/** A competent pilot: guards the core, keeps its distance, leads its shots a little. */
function pilotControl(state) {
  const p = state.player;
  const target = nearestEnemy(state);
  let goalX = CORE_X;
  let goalY = CORE_Y + 170;
  if (target) {
    goalX = target.x - (target.x - CORE_X) * 0.25;
    goalY = target.y - (target.y - CORE_Y) * 0.25;
  }
  let moveX = goalX - p.x;
  let moveY = goalY - p.y;
  const len = Math.hypot(moveX, moveY);
  if (len > 24) {
    moveX /= len;
    moveY /= len;
  } else {
    moveX = 0;
    moveY = 0;
  }
  if (!target) return { moveX, moveY, aimX: p.x, aimY: p.y - 100, firing: false };
  const dist = Math.hypot(target.x - p.x, target.y - p.y);
  const lead = dist / 640;
  return {
    moveX, moveY,
    aimX: target.x + target.vx * lead,
    aimY: target.y + target.vy * lead,
    firing: true,
  };
}

/** A doomed pilot: abandons the core and never fires, so the swarm wins. */
function doomedControl(state) {
  const p = state.player;
  const dx = 90 - p.x;
  const dy = 90 - p.y;
  const len = Math.hypot(dx, dy);
  return {
    moveX: len > 12 ? dx / len : 0,
    moveY: len > 12 ? dy / len : 0,
    aimX: p.x + 40,
    aimY: p.y,
    firing: false,
  };
}

function runSteps(world, seconds, controlFor) {
  const steps = Math.round(seconds / STEP);
  for (let i = 0; i < steps; i += 1) {
    world.step(STEP, controlFor(world.state));
    world.state.events.length = 0;
  }
}

/**
 * The scripted run behind the play scene: the pilot clears wave 1, takes the middle
 * draft card, and fights on into wave 2. onStep, when given, sees each step's index,
 * the state, and whether the draft has happened yet.
 */
function scriptedPlay(world, totalSteps, onStep) {
  const { state } = world;
  world.startRun();
  let drafted = false;
  for (let i = 0; i < totalSteps; i += 1) {
    if (state.screen === SCREEN_UPGRADE) {
      world.chooseUpgrade(1);
      drafted = true;
    }
    if (state.screen !== SCREEN_PLAY) break;
    world.step(STEP, pilotControl(state));
    world.state.events.length = 0;
    if (onStep) onStep(i, state, drafted);
  }
}

function stagePlay(seed) {
  const horizon = Math.round(75 / STEP);
  let bestStep = -1;
  let bestBusy = -1;
  const scout = createWorld(seed);
  scriptedPlay(scout, horizon, (i, state, drafted) => {
    if (!drafted) return;
    const busy = state.enemies.length * 3 + state.bullets.length + state.shards.length * 0.25;
    if (busy > bestBusy) {
      bestBusy = busy;
      bestStep = i;
    }
  });
  const world = createWorld(seed);
  if (bestStep < 0) {
    world.startRun();
    runSteps(world, 6.5, pilotControl);
    return world;
  }
  scriptedPlay(world, bestStep + 1, null);
  return world;
}

function stageUpgrade(seed) {
  const world = createWorld(seed);
  const { state } = world;
  world.startRun();
  for (let i = 0; i < 150 / STEP && state.screen === SCREEN_PLAY; i += 1) {
    world.step(STEP, pilotControl(state));
    world.state.events.length = 0;
  }
  return world;
}

function stageOver(seed) {
  const world = createWorld(seed);
  const { state } = world;
  world.startRun();
  for (let i = 0; i < 600 / STEP && state.screen !== SCREEN_OVER; i += 1) {
    if (state.screen === SCREEN_UPGRADE) world.chooseUpgrade(0);
    world.step(STEP, doomedControl(state));
    world.state.events.length = 0;
  }
  return world;
}

/** Build and stage the world for a screenshot scene; returns the world to render. */
export function stageWorld(name, seed) {
  if (name === 'play') return stagePlay(seed);
  if (name === 'upgrade') return stageUpgrade(seed);
  if (name === 'over') return stageOver(seed);
  // Title (and any unknown name): let the title screen breathe for two seconds.
  const world = createWorld(seed);
  runSteps(world, 2, () => IDLE);
  return world;
}

export const SHOT_SCREENS = {
  title: 'title',
  play: SCREEN_PLAY,
  upgrade: SCREEN_UPGRADE,
  over: SCREEN_OVER,
};
