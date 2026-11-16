// Boot and the one loop: a fixed 60 Hz simulation (game.js steps the match, this file steps
// the human) feeding a render at the display's rate. This file is the glue — camera, viewmodel,
// the player's trigger, bot bullets, grenades, sound triggers and the HUD feed — while every
// rule lives in game.js and every number in weapons.js.
//
// ?shot=buy|start|play|plant|end with &seed=N sets up a deterministic scene for a screenshot:
// the simulation is stepped a fixed number of times, the frame is painted twice, then frozen
// with window.__shotReady set, exactly the contract the kit's starter uses.
import * as THREE from 'three';
import { PALETTE } from './palette.js';
import { SITES } from './mapdata.js';
import { buildWorld } from './world.js';
import { createInput } from './input.js';
import { buildSoldier, poseSoldier, eyePos, stepActor } from './actors.js';
import { WEAPONS, GRENADES, ARMOR_PRICE, spreadFor } from './weapons.js';
import { firePellet } from './combat.js';
import { createMatch, stepMatch, damage, resolveExplosion, dropBomb, siteAtActor, endRound, CONFIG } from './game.js';
import { createFx, createChargeMesh, buildViewmodel } from './fx.js';
import { createHud, BUY_ITEMS } from './hud.js';
import { initAudio, sfx } from './audio.js';

const FIXED_STEP = 1 / 60;
const params = new URLSearchParams(window.location.search);
const shot = params.get('shot');
const seed = Number.parseInt(params.get('seed') ?? '1', 10) || 1;

function mulberry32(initial) {
  let a = initial;
  return function random() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(shot ? seed * 7919 : (Date.now() % 2147483647) + 1);

// --- Scene setup.
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.12;
document.getElementById('game').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(PALETTE.sky);
scene.fog = new THREE.Fog(new THREE.Color(PALETTE.fog), 30, 95);
const camera = new THREE.PerspectiveCamera(74, window.innerWidth / window.innerHeight, 0.05, 220);
scene.add(camera);

buildWorld(scene);
const fx = createFx(scene);
const hud = createHud();
const match = createMatch(rng);
const player = match.player;

const chargeMesh = createChargeMesh();
scene.add(chargeMesh);
for (const actor of match.actors) {
  if (actor.isPlayer) continue;
  scene.add(buildSoldier(actor));
}

// Viewmodels, one per gun, swapped on draw.
const viewmodels = {};
let viewmodel = null;
function drawWeapon(key) {
  if (viewmodel) camera.remove(viewmodel);
  if (!viewmodels[key]) viewmodels[key] = buildViewmodel(key);
  viewmodel = viewmodels[key];
  camera.add(viewmodel);
}
drawWeapon(player.loadout.current);

// --- Combat glue.
const _eye = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _point = new THREE.Vector3();
const _muzzle = new THREE.Vector3();
let viewKick = 0;
let muzzleFlashUntil = 0;

function finishReload(actor) {
  const load = actor.loadout;
  const def = WEAPONS[load.current];
  const take = Math.min(def.mag - load.mag, load.reserve);
  load.mag += take;
  load.reserve -= take;
  load.reloadEndsAt = 0;
  load.shotsFired = 0;
}
function startReload(actor) {
  const load = actor.loadout;
  const def = WEAPONS[load.current];
  if (load.reloadEndsAt || load.mag >= def.mag || load.reserve <= 0) return;
  load.reloadEndsAt = match.now + def.reloadMs;
  if (actor.isPlayer) sfx.reload();
}

// One trigger pull for any actor: pellets out, tracers drawn, damage through game.js.
function pullTrigger(shooter, aimDir) {
  const load = shooter.loadout;
  const def = WEAPONS[load.current];
  const now = match.now;
  if (load.reloadEndsAt) {
    if (now >= load.reloadEndsAt) finishReload(shooter);
    else return;
  }
  if (load.mag <= 0) {
    startReload(shooter);
    return;
  }
  load.mag -= 1;
  load.shotsFired += 1;
  eyePos(shooter, _eye);
  const spread = spreadFor(def, shooter.speedNow, shooter.crouched, false, load.shotsFired);
  _muzzle.copy(_eye).addScaledVector(aimDir, 0.55);
  _muzzle.y -= 0.14;
  let anyHit = false;
  for (let pellet = 0; pellet < def.pellets; pellet += 1) {
    _dir.copy(aimDir);
    _dir.x += (rng() * 2 - 1) * spread;
    _dir.y += (rng() * 2 - 1) * spread;
    _dir.z += (rng() * 2 - 1) * spread;
    _dir.normalize();
    const hit = firePellet(shooter, _eye, _dir, def, match.actors, _point);
    if (hit) {
      fx.tracer(_muzzle, _point, now);
      fx.impact(_point, Boolean(hit.victim), now);
      if (hit.victim) {
        anyHit = true;
        damage(match, hit.victim, shooter, hit.damage, hit.part);
      }
    }
  }
  fx.muzzle(_muzzle, now);
  match.lastShot = { x: shooter.pos.x, z: shooter.pos.z, team: shooter.team, at: now };
  const earshot = shooter.isPlayer || shooter.pos.distanceTo(player.pos) < 42;
  if (earshot) sfx.shot(load.current);
  if (shooter.isPlayer) {
    viewKick = 1;
    muzzleFlashUntil = now + 42;
    player.pitch += def.recoil * (0.75 + rng() * 0.5);
    player.yaw += (rng() * 2 - 1) * def.recoil * 0.55;
    if (load.mag === 0) startReload(shooter);
  }
  return anyHit;
}

// A bot's shot: aim at the target's chest (sometimes the head), with an error that grows with
// distance, target speed and the bot's own movement — the same honesty the player's spread has.
const _aim = new THREE.Vector3();
function botFireAt(bot, enemy) {
  const brain = bot.brain;
  const load = bot.loadout;
  const now = match.now;
  if (load.reloadEndsAt && now < load.reloadEndsAt) return;
  const headShot = rng() < brain.skill * 0.4;
  _aim.set(enemy.pos.x, enemy.pos.y + (headShot ? 1.52 : 1.12), enemy.pos.z);
  eyePos(bot, _eye);
  _aim.sub(_eye);
  const dist = _aim.length();
  _aim.normalize();
  const err = (1.02 - brain.skill) * 0.038 + dist * 0.00045 + enemy.speedNow * 0.0035;
  _aim.x += (rng() * 2 - 1) * err;
  _aim.y += (rng() * 2 - 1) * err * 0.7;
  _aim.z += (rng() * 2 - 1) * err;
  _aim.normalize();
  pullTrigger(bot, _aim);
}

function throwGrenadeAt(bot, targetPos) {
  if (bot.loadout.frag <= 0) return;
  bot.loadout.frag -= 1;
  eyePos(bot, _eye);
  _dir.set(targetPos.x - bot.pos.x, 0, targetPos.z - bot.pos.z);
  const dist = _dir.length();
  _dir.normalize();
  _dir.y = 0.55;
  _dir.normalize();
  fx.throwGrenade('frag', _eye, _dir, 9 + dist * 0.32, bot, match.now, GRENADES.frag.fuseMs);
}
const hooks = { fireAt: botFireAt, throwGrenadeAt };

// --- The player's own actions, stepped on the match clock.
const input = createInput(renderer.domElement, onLockChange);
let shotChannelWish = null;
let started = false;
let prevFiring = false;
let lastWeaponKey = 'sidearm';
let spectateIndex = 0;

function switchWeapon(key) {
  const load = player.loadout;
  if (key === load.current) return;
  if (key !== load.primary && key !== load.secondary) return;
  load.stash = load.stash ?? {};
  load.stash[load.current] = { mag: load.mag, reserve: load.reserve };
  lastWeaponKey = load.current;
  load.current = key;
  const kept = load.stash[key];
  const def = WEAPONS[key];
  load.mag = kept ? kept.mag : def.mag;
  load.reserve = kept ? kept.reserve : def.reserve;
  load.reloadEndsAt = 0;
  load.shotsFired = 0;
  drawWeapon(key);
}

function playerBuy(id) {
  const load = player.loadout;
  const item = BUY_ITEMS.find((entry) => entry.id === id);
  if (!item || player.money < item.price) return;
  if (item.kind === 'primary') {
    if (load.primary === id) return;
    player.money -= item.price;
    load.primary = id;
    load.stash = load.stash ?? {};
    load.stash[id] = { mag: WEAPONS[id].mag, reserve: WEAPONS[id].reserve };
    switchWeapon(id);
  } else if (item.kind === 'armor') {
    if (load.armor > 0) return;
    player.money -= item.price;
    load.armor = 100;
  } else if (item.kind === 'frag') {
    if (load.frag > 0) return;
    player.money -= item.price;
    load.frag = 1;
  } else if (item.kind === 'flash') {
    if (load.flash > 0) return;
    player.money -= item.price;
    load.flash = 1;
  }
  sfx.buy();
  hud.refreshBuy(player);
}
hud.setBuyCallback(playerBuy);

function playerStep(dt) {
  const now = match.now;
  const load = player.loadout;
  if (load.reloadEndsAt && now >= load.reloadEndsAt) finishReload(player);
  if (!input.state.firing && now - (load.lastShotAt ?? 0) > 260) load.shotsFired = 0;

  const look = input.takeLook();
  const sens = input.state.aiming && load.current === 'longbow' ? 0.0009 : 0.0023;
  player.yaw -= look.x * sens;
  player.pitch -= look.y * sens;
  player.pitch = Math.max(-1.45, Math.min(1.45, player.pitch));

  const pressed = input.takePressed();
  const buyOpen = match.phase === 'buy' && player.alive;
  if (buyOpen) {
    for (const item of BUY_ITEMS) if (pressed.has(item.key)) playerBuy(item.id);
  } else if (player.alive && match.phase === 'live') {
    if (pressed.has('Digit1') && load.primary) switchWeapon(load.primary);
    if (pressed.has('Digit2')) switchWeapon(load.secondary);
    if (pressed.has('KeyQ')) switchWeapon(lastWeaponKey);
    if (pressed.has('KeyG')) dropBomb(match, player);
    if (pressed.has('Digit4')) throwPlayerGrenade('frag');
    if (pressed.has('Digit5')) throwPlayerGrenade('flash');
  }
  if (pressed.has('KeyR')) startReload(player);
  if (pressed.has('KeyB') && match.phase === 'buy') hud.showBuy(player);

  // The charge: hold E at a site to plant. Defenders defuse the same way, but that is the
  // other team's job — the player is Ember Squad, so E only plants (or picks up by walking).
  // Shot scenes can force the wish through shotChannelWish, since they have no real keyboard.
  match.playerWantChannel = shotChannelWish;
  if (!match.playerWantChannel && player.alive && player.hasBomb && input.state.keys.has('KeyE') && siteAtActor(player)) {
    match.playerWantChannel = 'plant';
  }

  // Movement: wish direction from the keys, in the player's facing frame.
  const keys = input.state.keys;
  const forward = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0);
  const strafe = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0);
  const sin = Math.sin(player.yaw);
  const cos = Math.cos(player.yaw);
  const wish = { x: 0, z: 0 };
  wish.x = (-sin * forward + cos * strafe);
  wish.z = (-cos * forward - sin * strafe);
  const len = Math.hypot(wish.x, wish.z) || 1;
  wish.x /= len;
  wish.z /= len;
  if (!forward && !strafe) { wish.x = 0; wish.z = 0; }
  player.crouched = keys.has('ControlLeft') || keys.has('ControlRight');
  const walking = keys.has('ShiftLeft') || keys.has('ShiftRight');
  let maxSpeed = player.crouched ? 2.2 : walking ? 2.7 : 5.2;
  if (input.state.aiming && load.current === 'longbow') maxSpeed = Math.min(maxSpeed, 1.6);
  const frozen = match.phase === 'buy' || !player.alive;
  if (frozen) { wish.x = 0; wish.z = 0; }
  stepActor(player, dt, wish, keys.has('Space') && !frozen, maxSpeed);

  // Firing.
  const def = WEAPONS[load.current];
  const trigger = input.state.firing && player.alive && match.phase === 'live' && !frozen;
  const freshPress = trigger && !prevFiring;
  if (trigger && (def.auto || freshPress) && now >= load.nextShotAt) {
    camera.getWorldDirection(_dir);
    pullTrigger(player, _dir);
    load.lastShotAt = now;
    load.nextShotAt = now + 60000 / def.rpm;
  }
  prevFiring = input.state.firing;
}

function throwPlayerGrenade(kind) {
  const load = player.loadout;
  if (load[kind] <= 0) return;
  load[kind] -= 1;
  eyePos(player, _eye);
  camera.getWorldDirection(_dir);
  fx.throwGrenade(kind, _eye, _dir, 15.5, player, match.now, GRENADES[kind].fuseMs);
  sfx.throw_();
}

// --- Events out of game.js become sound, banners and screen effects here.
let lastBeepSecond = -1;
function drainEvents() {
  for (const event of match.events) {
    switch (event.kind) {
      case 'damage':
        if (event.attacker === player && event.victim.team !== player.team) {
          hud.hitmarker(false, performance.now());
          sfx.hit(event.part === 'head');
        }
        if (event.victim === player) {
          hud.hurtFlash();
          sfx.hurt();
        }
        break;
      case 'kill':
        if (event.attacker === player) {
          hud.hitmarker(true, performance.now());
          sfx.kill();
        }
        if (event.victim === player) spectateIndex = 0;
        break;
      case 'planted':
        hud.banner('CHARGE PLANTED', `Site ${event.site.id} — ${CONFIG.bombMs / 1000} seconds. Hold it.`, performance.now());
        sfx.plantBeep(true);
        lastBeepSecond = -1;
        break;
      case 'defused':
        hud.banner('CHARGE DEFUSED', '', performance.now());
        sfx.defused();
        break;
      case 'explosion':
        fx.explosion(event.pos, match.now);
        sfx.explosion();
        break;
      case 'roundStart':
        hud.banner(`ROUND ${event.round}`, match.siteTarget ? `Ember target: site ${match.siteTarget.id}` : '', performance.now(), 2200);
        break;
      case 'roundEnd': {
        const won = event.winner === player.team;
        const reasonText = {
          elimination: 'by elimination', detonation: 'the charge went off',
          defuse: 'the charge was defused', time: 'on the clock',
        }[event.reason];
        hud.banner(won ? 'ROUND WON' : 'ROUND LOST', `${event.winner === 'attack' ? 'Ember' : 'Watch'} take it ${reasonText}.`, performance.now(), 3400);
        if (won) sfx.roundWin(); else sfx.roundLose();
        break;
      }
      case 'matchEnd':
        hud.showOverlay('matchover', match);
        if (document.pointerLockElement) document.exitPointerLock();
        break;
      default:
        break;
    }
  }
  match.events.length = 0;
}

// --- Camera and posing.
let bobPhase = 0;
let currentFov = 74;
const _spectEye = new THREE.Vector3();
function syncCamera(dt) {
  let host = player;
  if (!player.alive && match.phase !== 'matchover') {
    const mates = match.actors.filter((a) => a.team === player.team && a.alive);
    if (mates.length) host = mates[spectateIndex % mates.length];
  }
  eyePos(host, _spectEye);
  bobPhase += host.speedNow * dt * 1.7;
  const bob = host.grounded && host.speedNow > 0.4 ? Math.sin(bobPhase) * 0.028 : 0;
  camera.position.set(_spectEye.x, _spectEye.y + bob, _spectEye.z);
  camera.rotation.set(host.pitch, host.yaw, 0, 'YXZ');
  const load = player.loadout;
  const scoped = input.state.aiming && load.current === 'longbow' && player.alive;
  const targetFov = scoped ? 29 : input.state.aiming && player.alive ? 64 : 74;
  currentFov += (targetFov - currentFov) * Math.min(1, dt * 11);
  camera.fov = currentFov;
  camera.updateProjectionMatrix();
  if (viewmodel) {
    viewmodel.visible = player.alive;
    viewKick = Math.max(0, viewKick - dt * 9);
    viewmodel.position.z = -0.45 + viewKick * 0.07;
    viewmodel.position.y = -0.22 + viewKick * 0.03 + bob * 0.4;
    viewmodel.userData.flash.material.opacity = match.now < muzzleFlashUntil ? 0.95 : 0;
    if (match.now < muzzleFlashUntil) viewmodel.userData.flash.rotation.z = rng() * Math.PI;
  }
  hud.setCrosshairGap(6 + player.speedNow * 2.2 + player.loadout.shotsFired * 1.6);
}

function syncChargeMesh() {
  const bomb = match.bomb;
  const lamp = chargeMesh.userData.lamp;
  if (bomb.state === 'carried' && bomb.carrier) {
    const carrier = bomb.carrier;
    chargeMesh.visible = true;
    chargeMesh.position.set(
      carrier.pos.x + Math.sin(carrier.yaw) * 0.3,
      carrier.pos.y + 1.12,
      carrier.pos.z + Math.cos(carrier.yaw) * 0.3,
    );
    chargeMesh.rotation.y = carrier.yaw;
    lamp.material.color.setHex(0xff3b30);
  } else if (bomb.state === 'dropped') {
    chargeMesh.visible = true;
    chargeMesh.position.set(bomb.pos.x, bomb.pos.y + 0.18, bomb.pos.z);
    chargeMesh.rotation.set(0, 0.6, 0);
    lamp.material.color.setHex(Math.floor(match.now / 600) % 2 ? 0xff3b30 : 0x661512);
  } else if (bomb.state === 'planted') {
    chargeMesh.visible = true;
    chargeMesh.position.set(bomb.pos.x, bomb.pos.y + 0.18, bomb.pos.z);
    const left = bomb.detonateAt - match.now;
    const blinkMs = left < 8000 ? 140 : 480;
    lamp.material.color.setHex(Math.floor(match.now / blinkMs) % 2 ? 0xff3b30 : 0x661512);
    const second = Math.ceil(left / 1000);
    if (second !== lastBeepSecond && left > 0) {
      lastBeepSecond = second;
      if (player.pos.distanceTo(bomb.pos) < 34) sfx.plantBeep(left < 8000);
    }
  } else {
    chargeMesh.visible = false;
  }
}

function onLockChange(locked) {
  if (shot) return;
  if (locked) {
    started = true;
    initAudio();
    hud.hideOverlay();
  } else if (match.phase !== 'matchover') {
    hud.showOverlay(started ? 'pause' : 'start', match);
  }
}
hud.onPlay(() => {
  if (shot) return;
  if (match.phase === 'matchover') {
    window.location.reload();
    return;
  }
  input.requestLock();
});
renderer.domElement.addEventListener('click', () => {
  if (!player.alive && started && match.phase === 'live') spectateIndex += 1;
});
window.addEventListener('keydown', (event) => {
  if (event.code === 'Tab') {
    event.preventDefault();
    hud.showScoreboard(match);
  }
});
window.addEventListener('keyup', (event) => {
  if (event.code === 'Tab') hud.hideScoreboard();
});

// --- The loop.
const grenadeEvents = [];
let accumulator = 0;
let lastTime = performance.now();
let paused = false;

function step(dt) {
  stepMatch(match, dt, hooks);
  playerStep(dt);
  const detonated = fx.stepGrenades(dt, match.now, grenadeEvents);
  for (const event of detonated) {
    if (event.kind === 'frag') {
      fx.explosion(event.pos, match.now);
      if (event.pos.distanceTo(player.pos) < 30) sfx.explosion();
      resolveExplosion(match, 'frag', event.pos, event.owner);
    } else {
      if (event.pos.distanceTo(player.pos) < 26) sfx.flash();
      const flashed = resolveExplosion(match, 'flash', event.pos, event.owner);
      if (flashed.includes(player)) hud.flashScreen(0.96);
    }
  }
  drainEvents();
}

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - lastTime) / 1000, 0.1);
  lastTime = now;
  paused = !shot && !input.state.locked && match.phase !== 'matchover';
  if (!paused) {
    accumulator += dt;
    let steps = 0;
    while (accumulator >= FIXED_STEP && steps < 5) {
      step(FIXED_STEP);
      accumulator -= FIXED_STEP;
      steps += 1;
    }
    if (accumulator > FIXED_STEP * 5) accumulator = 0;
  }
  for (const actor of match.actors) if (actor.mesh) poseSoldier(actor, match.now);
  syncChargeMesh();
  syncCamera(dt);
  fx.update(match.now);
  if (match.phase === 'buy' && player.alive && (input.state.locked || shot)) hud.showBuy(player);
  else hud.hideBuy();
  hud.update(match, player, now);
  renderer.render(scene, camera);
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// --- Deterministic scenes for screenshots (see shots.json).
function settle(steps) {
  for (let i = 0; i < steps; i += 1) step(FIXED_STEP);
}
function placePlayer(x, z, yaw, pitch = 0) {
  player.pos.set(x, 0, z);
  player.yaw = yaw;
  player.pitch = pitch;
}
function runShot(name) {
  hud.hideOverlay();
  if (name === 'buy') {
    placePlayer(player.pos.x, player.pos.z, Math.atan2(player.pos.x, player.pos.z));
    hud.showBuy(player);
  } else if (name === 'start') {
    match.phase = 'live';
    match.roundEndsAt = match.now + CONFIG.roundMs;
    settle(70);
  } else if (name === 'play') {
    match.phase = 'live';
    match.roundEndsAt = match.now + CONFIG.roundMs;
    settle(160);
    // Compose the duel: a defender holds the warehouse's south door, the player meets him
    // on the apron. Positions are set after the settle so the frame is the game's own
    // rendering of a real fight, arranged — the shot the kit's starter scenes also arrange.
    const defender = match.actors.find((a) => a.team === 'defend' && a.alive) ?? match.actors.find((a) => a.team === 'defend');
    defender.alive = true;
    defender.health = 100;
    defender.pos.set(15.5, 0, -6);
    defender.yaw = Math.atan2(-(13.5 - 15.5), -(2 - (-6)));
    placePlayer(13.5, 2, Math.atan2(-(15.5 - 13.5), -(-6 - 2)));
    syncCamera(0.016);
    camera.getWorldDirection(_dir);
    pullTrigger(player, _dir);
    settle(1);
  } else if (name === 'plant') {
    match.phase = 'live';
    match.roundEndsAt = match.now + CONFIG.roundMs;
    match.siteTarget = SITES[0];
    if (!player.hasBomb) {
      if (match.bomb.carrier) match.bomb.carrier.hasBomb = false;
      player.hasBomb = true;
      match.bomb.state = 'carried';
      match.bomb.carrier = player;
    }
    placePlayer(-17.5, -12, Math.atan2(-2.5, 3.4), -0.18);
    shotChannelWish = 'plant';
    settle(110);
    shotChannelWish = null;
    player.pitch = -0.3;
  } else if (name === 'end') {
    match.score.attack = 6;
    match.score.defend = 4;
    match.round = 11;
    match.phase = 'live';
    match.roundEndsAt = match.now + CONFIG.roundMs;
    placePlayer(11, 12, Math.atan2(-(19 - 11), -(13.5 - 12)));
    settle(30);
    endRound(match, 'attack', 'elimination');
    drainEvents();
  }
  for (const actor of match.actors) if (actor.mesh) poseSoldier(actor, match.now);
  syncChargeMesh();
  syncCamera(0.05);
  hud.update(match, player, performance.now());
  // Expire every transient effect the settle produced, so the frozen frame is the scene
  // itself (plus, for 'play', the viewmodel flash, which the camera drives separately).
  fx.update(match.now + 60000);
  if (name === 'play' || name === 'plant') hud.els.banner.hidden = true;
  let painted = 0;
  function paint() {
    renderer.render(scene, camera);
    painted += 1;
    if (painted === 2) window.__shotReady = true;
    else requestAnimationFrame(paint);
  }
  requestAnimationFrame(paint);
}

window.__match = match;   // a handle for screenshot tooling and curious players alike
window.__view = { camera, scene, renderer };
if (shot) runShot(shot);
else {
  hud.showOverlay('start', match);
  requestAnimationFrame(frame);
}
