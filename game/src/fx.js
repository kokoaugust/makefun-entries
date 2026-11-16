// Effects with fixed pools: tracers, impact puffs, muzzle flashes, the explosion, thrown
// grenades and the weapon in the player's hands. Pools are allocated once at boot and recycled
// by age, so a firefight never allocates in the render loop. Everything cosmetic lives here;
// nothing in this file can change who wins.
import * as THREE from 'three';
import { PALETTE } from './palette.js';
import { raycastWorld } from './world.js';

const TRACERS = 48;
const PUFFS = 40;

export function createFx(scene) {
  const tracerMat = new THREE.LineBasicMaterial({ color: 0xffd9a0, transparent: true, opacity: 0.85 });
  const tracers = [];
  for (let i = 0; i < TRACERS; i += 1) {
    const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
    const line = new THREE.Line(geo, tracerMat);
    line.visible = false;
    line.frustumCulled = false;
    scene.add(line);
    tracers.push({ line, until: 0 });
  }
  let tracerI = 0;

  const puffGeo = new THREE.SphereGeometry(0.09, 6, 5);
  const dustMat = new THREE.MeshBasicMaterial({ color: 0xb8ab90, transparent: true, opacity: 0.75 });
  const fleshMat = new THREE.MeshBasicMaterial({ color: 0xa33327, transparent: true, opacity: 0.85 });
  const puffs = [];
  for (let i = 0; i < PUFFS; i += 1) {
    const mesh = new THREE.Mesh(puffGeo, dustMat);
    mesh.visible = false;
    scene.add(mesh);
    puffs.push({ mesh, until: 0, grow: 1 });
  }
  let puffI = 0;

  const flashLight = new THREE.PointLight(0xffc37a, 0, 13, 1.6);
  scene.add(flashLight);
  let flashUntil = 0;

  const boomLight = new THREE.PointLight(0xff9a4a, 0, 30, 1.4);
  scene.add(boomLight);
  const boomBall = new THREE.Mesh(
    new THREE.SphereGeometry(1, 18, 14),
    new THREE.MeshBasicMaterial({ color: 0xffb35c, transparent: true, opacity: 0 }),
  );
  boomBall.visible = false;
  scene.add(boomBall);
  let boomAt = -1e9;
  const boomPos = new THREE.Vector3();

  const grenades = [];   // { mesh, vel, kind, fuseAt, owner }
  const grenadeGeo = new THREE.SphereGeometry(0.09, 10, 8);
  const fragMat = new THREE.MeshStandardMaterial({ color: 0x3f4a2f, roughness: 0.6, metalness: 0.3 });
  const flashMat = new THREE.MeshStandardMaterial({ color: 0xb9c0c7, roughness: 0.4, metalness: 0.5 });

  return {
    tracer(from, to, now) {
      const slot = tracers[tracerI];
      tracerI = (tracerI + 1) % TRACERS;
      const pos = slot.line.geometry.attributes.position;
      pos.setXYZ(0, from.x, from.y, from.z);
      pos.setXYZ(1, to.x, to.y, to.z);
      pos.needsUpdate = true;
      slot.line.visible = true;
      slot.until = now + 55;
    },
    impact(point, flesh, now) {
      const slot = puffs[puffI];
      puffI = (puffI + 1) % PUFFS;
      slot.mesh.material = flesh ? fleshMat : dustMat;
      slot.mesh.position.copy(point);
      slot.mesh.scale.setScalar(0.7 + Math.random() * 0.7);
      slot.mesh.visible = true;
      slot.until = now + 170;
      slot.grow = 2.6;
    },
    muzzle(point, now) {
      flashLight.position.copy(point);
      flashLight.intensity = 26;
      flashUntil = now + 45;
    },
    explosion(point, now) {
      boomPos.copy(point);
      boomAt = now;
      boomBall.position.copy(point);
      boomBall.visible = true;
      boomLight.position.copy(point).y += 1.2;
      boomLight.intensity = 320;
    },
    throwGrenade(kind, from, dir, speed, owner, now, fuseMs) {
      const mesh = new THREE.Mesh(grenadeGeo, kind === 'frag' ? fragMat : flashMat);
      mesh.position.copy(from);
      scene.add(mesh);
      grenades.push({
        mesh,
        vel: new THREE.Vector3(dir.x * speed, dir.y * speed + 3.4, dir.z * speed),
        kind,
        owner,
        fuseAt: now + fuseMs,
      });
    },
    // Advances grenades; returns the ones that went off this tick as { kind, pos, owner }.
    stepGrenades(dt, now, out) {
      out.length = 0;
      for (let i = grenades.length - 1; i >= 0; i -= 1) {
        const g = grenades[i];
        if (now >= g.fuseAt) {
          out.push({ kind: g.kind, pos: g.mesh.position.clone(), owner: g.owner });
          scene.remove(g.mesh);
          grenades.splice(i, 1);
          continue;
        }
        g.vel.y -= 12.5 * dt;
        g.mesh.position.addScaledVector(g.vel, dt);
        const p = g.mesh.position;
        if (p.y < 0.1) {
          p.y = 0.1;
          g.vel.y = Math.abs(g.vel.y) * 0.42;
          g.vel.x *= 0.72;
          g.vel.z *= 0.72;
        }
        // Cheap wall bounce: if the next step would be inside a wall, reflect the flat velocity.
        const probe = { x: p.x + g.vel.x * dt, y: Math.max(0.4, p.y), z: p.z + g.vel.z * dt };
        const back = { x: p.x - g.vel.x * dt, y: probe.y, z: p.z - g.vel.z * dt };
        const dirv = new THREE.Vector3(g.vel.x, 0, g.vel.z).normalize();
        if (raycastWorld(probe, dirv, 0.25) < 0.25 && raycastWorld(back, dirv, 0.25) >= 0.25) {
          g.vel.x *= -0.45;
          g.vel.z *= -0.45;
        }
      }
      return out;
    },
    update(now) {
      for (const t of tracers) if (t.line.visible && now > t.until) t.line.visible = false;
      for (const p of puffs) {
        if (!p.mesh.visible) continue;
        if (now > p.until) p.mesh.visible = false;
        else p.mesh.scale.multiplyScalar(1 + p.grow * 0.016);
      }
      if (now > flashUntil) flashLight.intensity = 0;
      if (boomAt > 0) {
        const t = (now - boomAt) / 620;
        if (t >= 1) {
          boomBall.visible = false;
          boomLight.intensity = 0;
          boomAt = -1e9;
        } else {
          boomBall.scale.setScalar(0.6 + t * 6.4);
          boomBall.material.opacity = 0.85 * (1 - t);
          boomLight.intensity = 320 * (1 - t);
        }
      }
    },
  };
}

// The breach charge: a slab with an antenna and a status light. Whoever carries it wears it
// on their back; planted, it sits on the site and blinks faster as the fuse burns down.
export function createChargeMesh() {
  const group = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(0.46, 0.34, 0.16),
    new THREE.MeshStandardMaterial({ color: 0x2c2f26, roughness: 0.55, metalness: 0.3 }),
  );
  body.castShadow = true;
  const stripe = new THREE.Mesh(
    new THREE.BoxGeometry(0.47, 0.09, 0.17),
    new THREE.MeshStandardMaterial({ color: PALETTE.ember, roughness: 0.6 }),
  );
  const lamp = new THREE.Mesh(
    new THREE.SphereGeometry(0.045, 8, 8),
    new THREE.MeshBasicMaterial({ color: 0xff3b30 }),
  );
  lamp.position.set(0.14, 0.22, 0);
  const antenna = new THREE.Mesh(
    new THREE.CylinderGeometry(0.012, 0.012, 0.42, 6),
    new THREE.MeshStandardMaterial({ color: 0x111111 }),
  );
  antenna.position.set(-0.16, 0.3, 0);
  group.add(body, stripe, lamp, antenna);
  group.userData.lamp = lamp;
  return group;
}

// A muzzle flash sprite painted on a canvas: a hot core with four spikes, so a frozen frame
// reads as a flash and not as a pale slab.
function muzzleFlashTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createRadialGradient(64, 64, 2, 64, 64, 62);
  gradient.addColorStop(0, 'rgba(255,246,220,1)');
  gradient.addColorStop(0.3, 'rgba(255,190,110,0.8)');
  gradient.addColorStop(1, 'rgba(255,120,40,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 128, 128);
  ctx.beginPath();
  for (let spike = 0; spike < 8; spike += 1) {
    const angle = (spike / 8) * Math.PI * 2 + 0.4;
    const reach = spike % 2 === 0 ? 60 : 26;
    ctx.moveTo(64, 64);
    ctx.lineTo(64 + Math.cos(angle - 0.06) * reach, 64 + Math.sin(angle - 0.06) * reach);
    ctx.lineTo(64 + Math.cos(angle + 0.06) * reach, 64 + Math.sin(angle + 0.06) * reach);
  }
  ctx.fill();
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

// First-person weapon models, one silhouette per gun, built from boxes at boot and swapped on
// draw. The muzzle marker is where flashes and tracers leave the barrel.
const VIEW_SHAPES = {
  sidearm: { body: [0.07, 0.13, 0.3], barrel: [0.045, 0.045, 0.16], mag: 0.1, scope: 0 },
  kestrel: { body: [0.08, 0.15, 0.52], barrel: [0.05, 0.05, 0.2], mag: 0.24, scope: 0 },
  breach12: { body: [0.1, 0.16, 0.62], barrel: [0.075, 0.075, 0.3], mag: 0.06, scope: 0 },
  vk7: { body: [0.08, 0.16, 0.66], barrel: [0.05, 0.05, 0.3], mag: 0.26, scope: 0 },
  longbow: { body: [0.08, 0.15, 0.8], barrel: [0.045, 0.045, 0.42], mag: 0.14, scope: 1 },
};

export function buildViewmodel(key) {
  const shape = VIEW_SHAPES[key] ?? VIEW_SHAPES.vk7;
  const group = new THREE.Group();
  const dark = new THREE.MeshStandardMaterial({ color: 0x232529, roughness: 0.45, metalness: 0.55 });
  const accent = new THREE.MeshStandardMaterial({ color: 0x3d4148, roughness: 0.5, metalness: 0.4 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(...shape.body), dark);
  const barrel = new THREE.Mesh(new THREE.BoxGeometry(...shape.barrel), accent);
  barrel.position.set(0, 0.03, -(shape.body[2] / 2 + shape.barrel[2] / 2));
  const mag = new THREE.Mesh(new THREE.BoxGeometry(0.055, shape.mag, 0.09), accent);
  mag.position.set(0, -(shape.body[1] / 2 + shape.mag / 2) + 0.03, 0.03);
  group.add(body, barrel, mag);
  if (shape.scope) {
    const scope = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.2, 10), dark);
    scope.rotation.x = Math.PI / 2;
    scope.position.set(0, 0.13, -0.05);
    group.add(scope);
  }
  const flash = new THREE.Mesh(
    new THREE.PlaneGeometry(0.4, 0.4),
    new THREE.MeshBasicMaterial({ map: muzzleFlashTexture(), transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }),
  );
  flash.position.set(0, 0.03, -(shape.body[2] / 2 + shape.barrel[2] + 0.08));
  group.add(flash);
  group.userData = { flash, muzzleZ: flash.position.z };
  group.position.set(0.24, -0.22, -0.45);
  return group;
}
