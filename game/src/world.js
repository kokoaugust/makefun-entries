// The yard itself: builds the three.js scene from mapdata's box list, and answers the two
// geometric questions the simulation asks every tick — "does this ray hit a wall, and how far?"
// and "can A see B?" — with slab tests against the same boxes, so what you see is exactly what
// blocks bullets and sight. Textures are painted on canvases at boot: no image files, no network.
import * as THREE from 'three';
import { PALETTE } from './palette.js';
import { BOXES, SILO, SOLIDS, SITES, YARD } from './mapdata.js';

function canvasTexture(size, painter, repeat) {
  const canvas = document.createElement('canvas');
  canvas.width = size[0];
  canvas.height = size[1];
  painter(canvas.getContext('2d'), size[0], size[1]);
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  if (repeat) texture.repeat.set(repeat[0], repeat[1]);
  texture.anisotropy = 4;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function speckle(ctx, w, h, base, flecks, count, alpha) {
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < count; i += 1) {
    ctx.fillStyle = flecks[i % flecks.length];
    ctx.globalAlpha = alpha * (0.4 + Math.random() * 0.6);
    ctx.fillRect(Math.random() * w, Math.random() * h, 2 + Math.random() * 5, 2 + Math.random() * 5);
  }
  ctx.globalAlpha = 1;
}

function buildMaterials() {
  const asphalt = canvasTexture([1024, 1024], (ctx, w, h) => {
    speckle(ctx, w, h, '#3d4148', ['#34383f', '#484d55', '#2e3238'], 2600, 0.5);
    ctx.strokeStyle = 'rgba(138,127,86,0.55)';
    ctx.lineWidth = 5;
    ctx.setLineDash([46, 30]);
    ctx.beginPath(); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke();
    ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(20,22,26,0.5)';
    ctx.lineWidth = 2;
    for (let i = 0; i < 7; i += 1) {
      ctx.beginPath();
      ctx.moveTo(Math.random() * w, Math.random() * h);
      ctx.lineTo(Math.random() * w, Math.random() * h);
      ctx.stroke();
    }
  }, [10, 7]);
  const concrete = canvasTexture([512, 512], (ctx, w, h) => {
    speckle(ctx, w, h, '#7d8288', ['#71767d', '#8b9096', '#666b72'], 1500, 0.45);
    ctx.fillStyle = 'rgba(30,32,36,0.18)';
    ctx.fillRect(0, h - 60, w, 60);
  }, [2, 1]);
  const concreteDark = canvasTexture([512, 512], (ctx, w, h) => {
    speckle(ctx, w, h, '#565b62', ['#4c5157', '#62676e'], 1500, 0.45);
  }, [2, 1]);
  const crate = canvasTexture([512, 512], (ctx, w, h) => {
    speckle(ctx, w, h, '#8a6b42', ['#7c5f39', '#997950'], 700, 0.4);
    ctx.strokeStyle = 'rgba(46,32,16,0.8)';
    ctx.lineWidth = 10;
    ctx.strokeRect(5, 5, w - 10, h - 10);
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(w, h); ctx.moveTo(w, 0); ctx.lineTo(0, h); ctx.stroke();
    ctx.lineWidth = 4;
    for (let y = 86; y < h; y += 86) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
  }, [1, 1]);
  const container = (hex) => canvasTexture([512, 512], (ctx, w, h) => {
    ctx.fillStyle = hex;
    ctx.fillRect(0, 0, w, h);
    for (let x = 0; x < w; x += 32) {
      ctx.fillStyle = 'rgba(0,0,0,0.22)';
      ctx.fillRect(x, 0, 9, h);
      ctx.fillStyle = 'rgba(255,255,255,0.10)';
      ctx.fillRect(x + 14, 0, 5, h);
    }
    ctx.fillStyle = 'rgba(20,16,10,0.25)';
    ctx.fillRect(0, h - 44, w, 44);
  }, [2, 1]);
  const metal = canvasTexture([512, 512], (ctx, w, h) => {
    speckle(ctx, w, h, '#9aa1a8', ['#8d939a', '#a8aeb5', '#7e858e'], 900, 0.4);
    ctx.strokeStyle = 'rgba(40,44,50,0.5)';
    ctx.lineWidth = 3;
    for (let y = 64; y < h; y += 64) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
  }, [3, 2]);

  const mat = (map, color) => new THREE.MeshStandardMaterial({ map, color, roughness: 0.94, metalness: 0.02 });
  return {
    ground: new THREE.MeshStandardMaterial({ map: asphalt, roughness: 1, metalness: 0 }),
    concrete: mat(concrete, 0xffffff),
    concreteDark: mat(concreteDark, 0xffffff),
    crate: mat(crate, 0xffffff),
    containerA: mat(container('#9c4a2f'), 0xffffff),
    containerB: mat(container('#2f5d8a'), 0xffffff),
    containerC: mat(container('#707a4a'), 0xffffff),
    metal: new THREE.MeshStandardMaterial({ map: metal, roughness: 0.55, metalness: 0.55 }),
    roof: new THREE.MeshStandardMaterial({ color: PALETTE.roof, roughness: 1 }),
  };
}

// AABB list for movement collision: { minX, maxX, minZ, maxZ, h } from the same solids.
export const COLLIDERS = SOLIDS.map(([x, z, w, d, h]) => ({
  minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2, h,
}));

export function buildWorld(scene) {
  const materials = buildMaterials();

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(YARD.halfX * 2 + 2, YARD.halfZ * 2 + 2),
    materials.ground,
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  const apron = new THREE.Mesh(
    new THREE.PlaneGeometry(300, 300),
    new THREE.MeshStandardMaterial({ color: 0x22252b, roughness: 1 }),
  );
  apron.rotation.x = -Math.PI / 2;
  apron.position.y = -0.05;
  scene.add(apron);

  const boxGeometry = new THREE.BoxGeometry(1, 1, 1);
  for (const [x, z, w, d, h, material] of BOXES) {
    const mesh = new THREE.Mesh(boxGeometry, materials[material]);
    mesh.scale.set(w, h, d);
    mesh.position.set(x, h / 2, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
  }

  // The silo: cylinder body, cone cap, and a ladder stripe, standing on site A.
  const silo = new THREE.Mesh(new THREE.CylinderGeometry(SILO.radius, SILO.radius, SILO.height, 24), materials.metal);
  silo.position.set(SILO.x, SILO.height / 2, SILO.z);
  silo.castShadow = true;
  silo.receiveShadow = true;
  scene.add(silo);
  const cap = new THREE.Mesh(new THREE.ConeGeometry(SILO.radius + 0.25, 1.8, 24), materials.roof);
  cap.position.set(SILO.x, SILO.height + 0.9, SILO.z);
  cap.castShadow = true;
  scene.add(cap);

  // Site rings painted on the asphalt, with the site letter in the middle.
  for (const site of SITES) {
    const ringTexture = canvasTexture([256, 256], (ctx, w, h) => {
      ctx.clearRect(0, 0, w, h);
      ctx.strokeStyle = site.id === 'A' ? '#ff8c3a' : '#ffc37a';
      ctx.lineWidth = 10;
      ctx.beginPath(); ctx.arc(w / 2, h / 2, 104, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.font = '700 120px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(site.id, w / 2, h / 2 + 6);
    });
    ringTexture.wrapS = THREE.ClampToEdgeWrapping;
    ringTexture.wrapT = THREE.ClampToEdgeWrapping;
    const ring = new THREE.Mesh(
      new THREE.PlaneGeometry(site.radius * 2, site.radius * 2),
      new THREE.MeshBasicMaterial({ map: ringTexture, transparent: true, depthWrite: false }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(site.x, 0.02, site.z);
    scene.add(ring);
  }

  // Floodlight poles at the corners of the yard: a pole, a head, and a warm glow sprite.
  const poleMaterial = new THREE.MeshStandardMaterial({ color: 0x3a3f46, roughness: 0.7, metalness: 0.5 });
  const headMaterial = new THREE.MeshStandardMaterial({ color: 0x222222, emissive: PALETTE.lamp, emissiveIntensity: 2.2 });
  const poleGeometry = new THREE.CylinderGeometry(0.09, 0.12, 7.5, 8);
  const headGeometry = new THREE.BoxGeometry(0.9, 0.3, 0.4);
  for (const [x, z] of [[-30, -20], [30, -20], [-30, 20], [30, 20], [0, -21], [0, 21]]) {
    const pole = new THREE.Mesh(poleGeometry, poleMaterial);
    pole.position.set(x, 3.75, z);
    pole.castShadow = true;
    scene.add(pole);
    const head = new THREE.Mesh(headGeometry, headMaterial);
    head.position.set(x, 7.5, z);
    scene.add(head);
  }

  // Dusk light: a low warm sun with shadows, a cool sky fill, and two warm points over the sites.
  const hemi = new THREE.HemisphereLight(0x8fa3c7, 0x3a3128, 1.12);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffb37a, 1.6);
  sun.position.set(-38, 30, -20);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -42;
  sun.shadow.camera.right = 42;
  sun.shadow.camera.top = 34;
  sun.shadow.camera.bottom = -34;
  sun.shadow.camera.far = 130;
  sun.shadow.bias = -0.0006;
  scene.add(sun);
  for (const site of SITES) {
    const glow = new THREE.PointLight(PALETTE.lamp, 60, 26, 1.8);
    glow.position.set(site.x, 6.5, site.z);
    scene.add(glow);
  }

  return { materials };
}

// Ray vs one AABB (with height), slab method. Returns the entry distance or Infinity.
function rayBox(ox, oy, oz, dx, dy, dz, c) {
  let tmin = 0;
  let tmax = Infinity;
  const axes = [
    [ox, dx, c.minX, c.maxX],
    [oy, dy, 0, c.h],
    [oz, dz, c.minZ, c.maxZ],
  ];
  for (const [o, d, lo, hi] of axes) {
    if (Math.abs(d) < 1e-9) {
      if (o < lo || o > hi) return Infinity;
    } else {
      let t1 = (lo - o) / d;
      let t2 = (hi - o) / d;
      if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return Infinity;
    }
  }
  return tmin;
}

// Nearest wall hit along a ray, and the ground plane if the ray points down. Infinity if none.
export function raycastWorld(origin, dir, maxDist) {
  let best = maxDist;
  for (const c of COLLIDERS) {
    const t = rayBox(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, c);
    if (t < best) best = t;
  }
  if (dir.y < -1e-6) {
    const t = -origin.y / dir.y;
    if (t > 0 && t < best) best = t;
  }
  return best;
}

// True when nothing solid stands between two points (used for bot vision and bullet checks
// between actors are resolved in main.js, which needs the distance, not just a boolean).
export function lineOfSight(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  const dist = Math.hypot(dx, dy, dz);
  if (dist < 1e-6) return true;
  const t = raycastWorld(a, { x: dx / dist, y: dy / dist, z: dz / dist }, dist);
  return t >= dist - 0.01;
}
