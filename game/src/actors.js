// Actors: the state every fighter shares (the human and the nine bots are the same shape),
// the movement physics that step them through the yard, and the low-poly soldier mesh each one
// wears. Combat numbers live in weapons.js; decisions live in bots.js; this file is body + legs.
import * as THREE from 'three';
import { PALETTE } from './palette.js';
import { COLLIDERS } from './world.js';
import { makeLoadout } from './weapons.js';

export const EYE_STAND = 1.62;
export const EYE_CROUCH = 1.06;
export const RADIUS = 0.35;
const GRAVITY = 13.5;
const JUMP_VEL = 4.9;

export const NAMES = {
  attack: ['Vex', 'Marlow', 'Ilya', 'Sable'],
  defend: ['Rurik', 'Tessa', 'Ondo', 'Pell'],
};

let nextId = 1;

export function makeActor(team, name, isPlayer) {
  return {
    id: nextId++,
    team,
    name,
    isPlayer,
    alive: true,
    health: 100,
    pos: new THREE.Vector3(),
    vel: new THREE.Vector3(),
    yaw: 0,
    pitch: 0,
    crouched: false,
    grounded: true,
    speedNow: 0,          // horizontal speed last step, drives spread and animation
    loadout: makeLoadout(),
    money: 800,
    kills: 0,
    deaths: 0,
    hasBomb: false,
    channel: null,         // { kind: 'plant'|'defuse', until } while working the charge
    lastDamageAt: -1e9,
    lastAttackerId: 0,
    flashUntil: 0,         // match-clock ms the actor is blinded until
    mesh: null,
    brain: null,           // bots.js attaches its state here
    deadAt: 0,
  };
}

export function eyeHeight(actor) {
  return actor.crouched ? EYE_CROUCH : EYE_STAND;
}

export function eyePos(actor, out) {
  return out.set(actor.pos.x, actor.pos.y + eyeHeight(actor), actor.pos.z);
}

// Step one actor: accelerate toward the wish direction, apply gravity, then resolve against
// every solid box. wish is a unit vector on the ground plane (or zero). Landing on a crate top
// counts as ground, so low cover can be climbed and fought from.
export function stepActor(actor, dt, wish, wantJump, maxSpeed) {
  const accel = actor.grounded ? 42 : 6;
  const targetX = wish.x * maxSpeed;
  const targetZ = wish.z * maxSpeed;
  const blend = Math.min(1, accel * dt / Math.max(1, maxSpeed));
  if (actor.grounded) {
    actor.vel.x += (targetX - actor.vel.x) * blend;
    actor.vel.z += (targetZ - actor.vel.z) * blend;
  } else {
    actor.vel.x += wish.x * accel * dt * 0.35;
    actor.vel.z += wish.z * accel * dt * 0.35;
  }
  if (wantJump && actor.grounded) {
    actor.vel.y = JUMP_VEL;
    actor.grounded = false;
  }
  actor.vel.y -= GRAVITY * dt;

  const prevFeet = actor.pos.y;
  actor.pos.x += actor.vel.x * dt;
  actor.pos.z += actor.vel.z * dt;
  actor.pos.y += actor.vel.y * dt;

  actor.grounded = false;
  if (actor.pos.y <= 0) {
    actor.pos.y = 0;
    actor.vel.y = 0;
    actor.grounded = true;
  }
  for (const c of COLLIDERS) {
    const nearX = Math.max(c.minX, Math.min(actor.pos.x, c.maxX));
    const nearZ = Math.max(c.minZ, Math.min(actor.pos.z, c.maxZ));
    const dx = actor.pos.x - nearX;
    const dz = actor.pos.z - nearZ;
    const distSq = dx * dx + dz * dz;
    if (distSq > RADIUS * RADIUS) continue;
    // Land on top when falling onto the box from above.
    if (actor.vel.y <= 0 && prevFeet >= c.h - 0.02 && actor.pos.y < c.h) {
      actor.pos.y = c.h;
      actor.vel.y = 0;
      actor.grounded = true;
      continue;
    }
    if (actor.pos.y >= c.h - 0.25) continue;   // standing on it, no side push
    if (distSq > 1e-9) {
      const dist = Math.sqrt(distSq);
      actor.pos.x = nearX + (dx / dist) * RADIUS;
      actor.pos.z = nearZ + (dz / dist) * RADIUS;
    } else {
      // Centre inside the box footprint: push out along the smaller penetration.
      const pushLeft = actor.pos.x - c.minX;
      const pushRight = c.maxX - actor.pos.x;
      const pushBack = actor.pos.z - c.minZ;
      const pushFront = c.maxZ - actor.pos.z;
      const smallest = Math.min(pushLeft, pushRight, pushBack, pushFront);
      if (smallest === pushLeft) actor.pos.x = c.minX - RADIUS;
      else if (smallest === pushRight) actor.pos.x = c.maxX + RADIUS;
      else if (smallest === pushBack) actor.pos.z = c.minZ - RADIUS;
      else actor.pos.z = c.maxZ + RADIUS;
    }
  }
  actor.speedNow = Math.hypot(actor.vel.x, actor.vel.z);
}

// Where a bullet can hit this actor: a head sphere and a body box, in world space.
export function hitboxes(actor) {
  const crouchDrop = actor.crouched ? 0.5 : 0;
  return {
    head: { x: actor.pos.x, y: actor.pos.y + 1.56 - crouchDrop, z: actor.pos.z, r: 0.21 },
    body: {
      minX: actor.pos.x - 0.34, maxX: actor.pos.x + 0.34,
      minZ: actor.pos.z - 0.34, maxZ: actor.pos.z + 0.34,
      base: actor.pos.y, top: actor.pos.y + 1.38 - crouchDrop,
    },
  };
}

// --- The soldier mesh: boxes and a sphere, team-coloured, with a swinging walk and a nameplate.

function nameplate(name, color) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 56;
  const ctx = canvas.getContext('2d');
  ctx.font = '600 30px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = 'rgba(0,0,0,0.9)';
  ctx.shadowBlur = 6;
  ctx.fillStyle = color;
  ctx.fillText(name, 128, 28);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true }));
  sprite.scale.set(1.5, 0.33, 1);
  sprite.position.y = 2.05;
  return sprite;
}

export function buildSoldier(actor) {
  const teamColor = actor.team === 'attack' ? PALETTE.ember : PALETTE.watch;
  const darkColor = actor.team === 'attack' ? PALETTE.emberDark : PALETTE.watchDark;
  const cloth = new THREE.MeshStandardMaterial({ color: darkColor, roughness: 0.9 });
  const vest = new THREE.MeshStandardMaterial({ color: teamColor, roughness: 0.85 });
  const skin = new THREE.MeshStandardMaterial({ color: 0xc9a189, roughness: 0.7 });
  const gunMat = new THREE.MeshStandardMaterial({ color: 0x1c1e22, roughness: 0.5, metalness: 0.5 });

  const group = new THREE.Group();
  const legL = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.78, 0.19), cloth);
  legL.position.set(-0.13, 0.39, 0);
  const legR = legL.clone();
  legR.position.x = 0.13;
  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.54, 0.64, 0.3), vest);
  torso.position.y = 1.1;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.165, 14, 12), skin);
  head.position.y = 1.58;
  const helmet = new THREE.Mesh(new THREE.BoxGeometry(0.37, 0.13, 0.37), cloth);
  helmet.position.y = 1.68;
  const gun = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.16, 0.78), gunMat);
  gun.position.set(0.17, 1.22, -0.42);
  const arm = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.13, 0.5), cloth);
  arm.position.set(0.17, 1.2, -0.18);
  for (const part of [legL, legR, torso, head, helmet, gun, arm]) {
    part.castShadow = true;
    group.add(part);
  }
  if (!actor.isPlayer) group.add(nameplate(actor.name, actor.team === 'attack' ? '#ffb37a' : '#a9c8f5'));
  group.userData = { legL, legR, torso, head, helmet, gun, vest };
  actor.mesh = group;
  return group;
}

// Pose the mesh from the actor's state: position, facing, walk swing, crouch, death fall.
const walkPhase = new Map();
export function poseSoldier(actor, nowMs) {
  const group = actor.mesh;
  if (!group) return;
  group.position.copy(actor.pos);
  group.rotation.set(0, actor.yaw, 0);
  const parts = group.userData;
  if (!actor.alive) {
    const fall = Math.min(1, (nowMs - actor.deadAt) / 380);
    group.rotation.x = -fall * Math.PI * 0.48;
    group.position.y = actor.pos.y + fall * 0.12;
    return;
  }
  group.rotation.x = 0;
  const phase = (walkPhase.get(actor.id) ?? 0) + actor.speedNow * 0.055;
  walkPhase.set(actor.id, phase);
  const swing = Math.sin(phase) * Math.min(0.55, actor.speedNow * 0.11);
  parts.legL.rotation.x = swing;
  parts.legR.rotation.x = -swing;
  const crouch = actor.crouched ? 0.34 : 0;
  parts.torso.position.y = 1.1 - crouch;
  parts.head.position.y = 1.58 - crouch;
  parts.helmet.position.y = 1.68 - crouch;
  parts.gun.position.y = 1.22 - crouch;
  parts.legL.scale.y = actor.crouched ? 0.55 : 1;
  parts.legR.scale.y = actor.crouched ? 0.55 : 1;
}
