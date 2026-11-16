// The match: one state object, one step function. Rounds, the clock, the money, the charge and
// every win condition are decided here and nowhere else — the renderer, the HUD and the bots
// all read this state, and combat results arrive through damage() so a kill is priced, fed to
// the killfeed and checked against the round's end in exactly one place.
import * as THREE from 'three';
import { SPAWNS, SITES } from './mapdata.js';
import { makeActor, NAMES, stepActor } from './actors.js';
import { createBrain, stepBot, botBuy } from './bots.js';
import { WEAPONS, makeLoadout } from './weapons.js';
import { applyArmor } from './combat.js';
import { lineOfSight } from './world.js';

export const CONFIG = {
  roundsToWin: 7,
  maxRounds: 12,
  buyMs: 12000,
  roundMs: 100000,
  plantMs: 3200,
  defuseMs: 5000,
  bombMs: 35000,
  endMs: 5200,
  startMoney: 800,
  winAward: 1400,
  lossBase: 1000,
  lossStep: 250,
  killAward: 300,
  plantAward: 300,
  teamPlantAward: 800,
  defuseAward: 300,
};

export function createMatch(rng) {
  const actors = [];
  const player = makeActor('attack', 'You', true);
  actors.push(player);
  NAMES.attack.forEach((name, i) => {
    const bot = makeActor('attack', name, false);
    bot.brain = createBrain(bot, 0.45 + i * 0.1);
    actors.push(bot);
  });
  NAMES.defend.forEach((name, i) => {
    const bot = makeActor('defend', name, false);
    bot.brain = createBrain(bot, 0.5 + i * 0.09);
    actors.push(bot);
  });
  // A fifth defender rounds out the five-on-five.
  const fifth = makeActor('defend', 'Havoc', false);
  fifth.brain = createBrain(fifth, 0.62);
  actors.push(fifth);

  const match = {
    now: 0,
    phase: 'buy',
    phaseEndsAt: CONFIG.buyMs,
    roundEndsAt: 0,
    round: 1,
    score: { attack: 0, defend: 0 },
    lossStreak: { attack: 0, defend: 0 },
    actors,
    player,
    bomb: { state: 'carried', carrier: null, pos: new THREE.Vector3(), site: null, detonateAt: 0 },
    siteTarget: SITES[0],
    defuserId: 0,
    carrierHopefulId: 0,
    lastShot: null,
    killfeed: [],
    events: [],
    channels: new Map(),
    winner: null,
    winReason: '',
    rng,
    playerWantChannel: null,
    stats: { shots: 0, hits: 0 },
  };
  startRound(match, true);
  return match;
}

function teamActors(match, team) {
  return match.actors.filter((a) => a.team === team);
}

function aliveCount(match, team) {
  return match.actors.reduce((n, a) => n + (a.team === team && a.alive ? 1 : 0), 0);
}

export function startRound(match, first = false) {
  const rng = match.rng;
  match.phase = 'buy';
  match.phaseEndsAt = match.now + CONFIG.buyMs;
  match.channels.clear();
  match.killfeed.length = 0;
  match.siteTarget = rng() < 0.55 ? SITES[0] : SITES[1];

  for (const team of ['attack', 'defend']) {
    const spawns = SPAWNS[team];
    teamActors(match, team).forEach((actor, i) => {
      const [x, z] = spawns[i % spawns.length];
      actor.pos.set(x, 0, z);
      actor.vel.set(0, 0, 0);
      actor.yaw = Math.atan2(x, z);   // face the middle of the yard
      actor.pitch = 0;
      actor.alive = true;
      actor.health = 100;
      actor.crouched = false;
      actor.channel = null;
      actor.flashUntil = 0;
      actor.hasBomb = false;
      if (first) {
        actor.money = CONFIG.startMoney;
        actor.loadout = makeLoadout();
        actor.kills = 0;
        actor.deaths = 0;
      } else if (actor.deadLastRound) {
        actor.loadout = makeLoadout();   // died: gear is gone, money is not
      } else {
        const def = WEAPONS[actor.loadout.current];
        actor.loadout.mag = def.mag;
        actor.loadout.reserve = def.reserve;
        actor.loadout.reloadEndsAt = 0;
      }
      actor.deadLastRound = false;
      if (actor.mesh) actor.mesh.visible = true;
    });
  }

  // Roles: defenders split A / B / mid; attackers escort the carrier, one watches mid.
  const defenders = teamActors(match, 'defend').filter((a) => !a.isPlayer);
  defenders.forEach((bot, i) => {
    bot.brain.role = ['A', 'A', 'B', 'B', 'mid'][i % 5];
    bot.brain.holdPos = null;
    bot.brain.goal = null;
    bot.brain.enemy = null;
  });
  const attackers = teamActors(match, 'attack');
  attackers.forEach((actor) => {
    if (actor.brain) {
      actor.brain.role = 'escort';
      actor.brain.holdPos = null;
      actor.brain.goal = null;
      actor.brain.enemy = null;
    }
  });
  const mid = attackers.find((a) => a.brain && a.id % 3 === 0);
  if (mid) mid.brain.role = 'mid';

  // The charge goes to a random attacker; the carrier's brain reads hasBomb.
  const carrier = attackers[Math.floor(rng() * attackers.length)];
  carrier.hasBomb = true;
  match.bomb.state = 'carried';
  match.bomb.carrier = carrier;
  match.bomb.site = null;
  match.bomb.plantedOnce = false;
  match.bomb.pos.copy(carrier.pos);

  for (const actor of match.actors) if (actor.brain) botBuy(actor);
  match.events.push({ kind: 'roundStart', round: match.round });
}

// Apply damage from one actor to another (or from the world, attacker null). Handles armour,
// death, the bomb dropping, kill money and the elimination win checks.
export function damage(match, victim, attacker, amount, part) {
  if (!victim.alive || match.phase === 'over' || match.phase === 'matchover') return;
  const dealt = applyArmor(victim, Math.round(amount));
  victim.health -= dealt;
  victim.lastDamageAt = match.now;
  victim.lastAttackerId = attacker ? attacker.id : 0;
  if (attacker && attacker.isPlayer && victim.team !== attacker.team) match.stats.hits += 1;
  match.events.push({ kind: 'damage', victim, attacker, amount: dealt, part });
  if (victim.health > 0) return;

  victim.health = 0;
  victim.alive = false;
  victim.deadAt = match.now;
  victim.deadLastRound = true;
  victim.deaths += 1;
  match.channels.delete(victim.id);
  if (attacker && attacker !== victim) {
    attacker.kills += 1;
    if (attacker.team !== victim.team) attacker.money += CONFIG.killAward;
  }
  match.killfeed.unshift({
    text: `${attacker ? attacker.name : 'The yard'} ▸ ${victim.name}${part === 'head' ? ' ⌖' : ''}`,
    at: match.now,
    team: attacker ? attacker.team : null,
  });
  match.killfeed.length = Math.min(match.killfeed.length, 5);
  match.events.push({ kind: 'kill', victim, attacker, part });

  if (victim.hasBomb) {
    victim.hasBomb = false;
    match.bomb.state = 'dropped';
    match.bomb.carrier = null;
    match.bomb.pos.copy(victim.pos);
    match.events.push({ kind: 'bombDropped', pos: match.bomb.pos });
  }
  checkElimination(match);
}

function checkElimination(match) {
  if (match.phase !== 'live') return;
  const attackersAlive = aliveCount(match, 'attack');
  const defendersAlive = aliveCount(match, 'defend');
  if (defendersAlive === 0) endRound(match, 'attack', 'elimination');
  else if (attackersAlive === 0 && match.bomb.state !== 'planted') endRound(match, 'defend', 'elimination');
}

export function endRound(match, winner, reason) {
  if (match.phase === 'over' || match.phase === 'matchover') return;
  match.phase = 'over';
  match.phaseEndsAt = match.now + CONFIG.endMs;
  match.winner = winner;
  match.winReason = reason;
  match.score[winner] += 1;
  const loser = winner === 'attack' ? 'defend' : 'attack';
  match.lossStreak[loser] += 1;
  match.lossStreak[winner] = 0;
  const lossAward = CONFIG.lossBase + CONFIG.lossStep * (match.lossStreak[loser] - 1);
  for (const actor of match.actors) {
    if (actor.team === winner) actor.money += CONFIG.winAward;
    else actor.money += lossAward;
    // A team that got the charge down earns its plant bonus even when the round slips away.
    if (actor.team === 'attack' && loser === 'attack' && match.bomb.plantedOnce) {
      actor.money += CONFIG.teamPlantAward;
    }
    actor.money = Math.min(actor.money, 16000);
  }
  match.events.push({ kind: 'roundEnd', winner, reason });
}

function finishMatchIfDone(match) {
  const { attack, defend } = match.score;
  if (attack >= CONFIG.roundsToWin || defend >= CONFIG.roundsToWin || match.round >= CONFIG.maxRounds) {
    match.phase = 'matchover';
    match.matchWinner = attack === defend ? null : attack > defend ? 'attack' : 'defend';
    match.events.push({ kind: 'matchEnd', winner: match.matchWinner });
    return true;
  }
  return false;
}

// Channels: planting and defusing are timed, stationary, and cancelled by moving, shooting
// or dying. game.js owns the table; main.js and bots.js only express the wish.
function stepChannels(match) {
  const now = match.now;
  const wishes = new Map();
  for (const actor of match.actors) {
    if (!actor.alive) continue;
    if (actor.isPlayer) {
      if (match.playerWantChannel) wishes.set(actor.id, match.playerWantChannel);
    } else if (actor.brain && actor.brain.channelWanted) {
      wishes.set(actor.id, actor.brain.channelWanted);
    }
  }
  for (const [id, channel] of [...match.channels]) {
    if (!wishes.has(id) || wishes.get(id) !== channel.kind) match.channels.delete(id);
  }
  for (const [id, kind] of wishes) {
    if (match.channels.has(id)) continue;
    const actor = match.actors.find((a) => a.id === id);
    const duration = kind === 'plant' ? CONFIG.plantMs : CONFIG.defuseMs;
    match.channels.set(id, { kind, actor, endsAt: now + duration, startedAt: now });
    match.events.push({ kind: 'channelStart', actor, channelKind: kind });
  }
  for (const [id, channel] of [...match.channels]) {
    if (now < channel.endsAt) continue;
    match.channels.delete(id);
    const actor = channel.actor;
    if (channel.kind === 'plant' && actor.hasBomb) {
      const site = siteAt(actor);
      if (!site) continue;
      actor.hasBomb = false;
      actor.money += CONFIG.plantAward;
      match.bomb.state = 'planted';
      match.bomb.carrier = null;
      match.bomb.site = site;
      match.bomb.plantedOnce = true;
      match.bomb.pos.copy(actor.pos);
      match.bomb.detonateAt = now + CONFIG.bombMs;
      match.events.push({ kind: 'planted', actor, site });
    } else if (channel.kind === 'defuse' && match.bomb.state === 'planted') {
      actor.money += CONFIG.defuseAward;
      match.bomb.state = 'defused';
      match.events.push({ kind: 'defused', actor });
      endRound(match, 'defend', 'defuse');
    }
  }
}

// Which site an actor is standing in, or null.
function siteAt(actor) {
  for (const site of SITES) {
    if (Math.hypot(actor.pos.x - site.x, actor.pos.z - site.z) < site.radius) return site;
  }
  return null;
}

// The match clock and everything that flows from it. ctx carries main.js's fireAt callback.
const _botCtx = { now: 0, actors: null, bomb: null, siteTarget: null, defuserId: 0, carrierHopefulId: 0, lastShot: null, fireAt: null, throwGrenadeAt: null };
const _wish = { x: 0, z: 0 };

export function stepMatch(match, dt, hooks) {
  match.now += dt * 1000;
  const now = match.now;

  if (match.phase === 'buy' && now >= match.phaseEndsAt) {
    match.phase = 'live';
    match.roundEndsAt = now + CONFIG.roundMs;
    match.events.push({ kind: 'live' });
  }
  if (match.phase === 'over' && now >= match.phaseEndsAt) {
    if (!finishMatchIfDone(match)) {
      match.round += 1;
      startRound(match);
    }
  }
  if (match.phase !== 'live') return;

  // The clocks that can end a round.
  if (match.bomb.state === 'planted' && now >= match.bomb.detonateAt) {
    match.events.push({ kind: 'explosion', pos: match.bomb.pos });
    match.bomb.state = 'detonated';
    endRound(match, 'attack', 'detonation');
    return;
  }
  if (match.bomb.state !== 'planted' && now >= match.roundEndsAt) {
    endRound(match, 'defend', 'time');
    return;
  }

  // Who should fetch the dropped charge, and who should defuse the planted one.
  if (match.bomb.state === 'dropped') {
    let best = null;
    let bestDist = Infinity;
    for (const a of match.actors) {
      if (!a.alive || a.team !== 'attack') continue;
      const d = a.pos.distanceTo(match.bomb.pos);
      if (d < bestDist) { bestDist = d; best = a; }
    }
    match.carrierHopefulId = best ? best.id : 0;
    if (best && bestDist < 1.15) {
      best.hasBomb = true;
      match.bomb.state = 'carried';
      match.bomb.carrier = best;
      match.events.push({ kind: 'bombPickup', actor: best });
    }
  }
  if (match.bomb.state === 'planted') {
    let best = null;
    let bestDist = Infinity;
    for (const a of match.actors) {
      if (!a.alive || a.team !== 'defend') continue;
      const d = a.pos.distanceTo(match.bomb.pos);
      if (d < bestDist) { bestDist = d; best = a; }
    }
    match.defuserId = best ? best.id : 0;
  }
  if (match.bomb.state === 'carried' && match.bomb.carrier) {
    match.bomb.pos.copy(match.bomb.carrier.pos);
  }

  stepChannels(match);

  // Bots act. The player is stepped by main.js from real input.
  _botCtx.now = now;
  _botCtx.actors = match.actors;
  _botCtx.bomb = match.bomb;
  _botCtx.siteTarget = match.siteTarget;
  _botCtx.defuserId = match.defuserId;
  _botCtx.carrierHopefulId = match.carrierHopefulId;
  _botCtx.lastShot = match.lastShot;
  _botCtx.fireAt = hooks.fireAt;
  _botCtx.throwGrenadeAt = hooks.throwGrenadeAt;
  for (const actor of match.actors) {
    if (actor.isPlayer || !actor.alive) continue;
    const move = stepBot(actor, dt, _botCtx);
    _wish.x = move.wish.x;
    _wish.z = move.wish.z;
    stepActor(actor, dt, _wish, move.jump, move.speed || 5.2);
  }
}

// A grenade going off, resolved here so damage flows through damage() like a bullet's.
// Returns the list of actors flashed (for the caller's screen effect when it is the player).
export function resolveExplosion(match, kind, pos, owner) {
  const flashed = [];
  if (kind === 'frag') {
    for (const actor of match.actors) {
      if (!actor.alive) continue;
      const centre = { x: actor.pos.x, y: actor.pos.y + 1.1, z: actor.pos.z };
      const dist = Math.hypot(centre.x - pos.x, centre.y - pos.y, centre.z - pos.z);
      if (dist > 6.5) continue;
      if (!lineOfSight(pos, centre)) continue;
      const amount = Math.max(8, 92 * (1 - dist / 6.5));
      if (actor !== owner) damage(match, actor, owner, amount, 'body');
    }
  } else {
    for (const actor of match.actors) {
      if (!actor.alive || actor === owner) continue;
      const centre = { x: actor.pos.x, y: actor.pos.y + 1.4, z: actor.pos.z };
      const dist = Math.hypot(centre.x - pos.x, centre.y - pos.y, centre.z - pos.z);
      if (dist > 14) continue;
      if (!lineOfSight(pos, centre)) continue;
      // Full effect when looking at the pop, a glance when close with your back turned.
      const facingX = -Math.sin(actor.yaw);
      const facingZ = -Math.cos(actor.yaw);
      const dot = ((pos.x - actor.pos.x) * facingX + (pos.z - actor.pos.z) * facingZ) / (Math.hypot(pos.x - actor.pos.x, pos.z - actor.pos.z) || 1);
      const strength = dot > 0.15 ? 1 : dist < 3.5 ? 0.45 : 0;
      if (strength > 0) {
        actor.flashUntil = match.now + (500 + 2400 * strength * (1 - dist / 15));
        flashed.push(actor);
      }
    }
  }
  return flashed;
}

// Small helpers the HUD and main.js read.
export function timeLeft(match) {
  if (match.phase === 'buy') return Math.max(0, match.phaseEndsAt - match.now);
  if (match.phase === 'over' || match.phase === 'matchover') return Math.max(0, match.phaseEndsAt - match.now);
  if (match.bomb.state === 'planted') return Math.max(0, match.bomb.detonateAt - match.now);
  return Math.max(0, match.roundEndsAt - match.now);
}

export function siteAtActor(actor) {
  return siteAt(actor);
}

// The carrier puts the charge down where they stand (the G key, or a scripted drop).
export function dropBomb(match, actor) {
  if (!actor.hasBomb || match.bomb.state !== 'carried') return;
  actor.hasBomb = false;
  match.bomb.state = 'dropped';
  match.bomb.carrier = null;
  match.bomb.pos.copy(actor.pos);
  match.events.push({ kind: 'bombDropped', pos: match.bomb.pos });
}
