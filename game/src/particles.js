// A pooled particle system: sparks, explosion debris, muzzle flashes and shard glints.
// Particles are plain data recycled through a free list, so a busy wave never allocates.

const MAX_PARTICLES = 900;

export function createParticles() {
  const pool = [];
  const live = [];
  for (let i = 0; i < MAX_PARTICLES; i += 1) {
    pool.push({ x: 0, y: 0, vx: 0, vy: 0, life: 0, maxLife: 1, size: 2, color: '#fff', drag: 1, glow: false, round: false });
  }

  function spawn({ x, y, vx, vy, life, size, color, drag = 2.2, glow = false, round = false }) {
    const p = pool.pop();
    if (!p) return;
    p.x = x; p.y = y; p.vx = vx; p.vy = vy;
    p.life = life; p.maxLife = life; p.size = size; p.color = color; p.drag = drag; p.glow = glow; p.round = round;
    live.push(p);
  }

  return {
    /** A radial burst of sparks, the game's all-purpose explosion. */
    burst(x, y, color, count, rng, speed = 260, size = 3) {
      for (let i = 0; i < count; i += 1) {
        const angle = rng.angle();
        const v = speed * rng.range(0.25, 1);
        spawn({
          x, y,
          vx: Math.cos(angle) * v, vy: Math.sin(angle) * v,
          life: rng.range(0.25, 0.7), size: size * rng.range(0.6, 1.5), color, glow: true,
        });
      }
    },
    /** A few sparks flying off a hit point, biased along the impact direction. */
    sparks(x, y, color, count, rng, baseAngle) {
      for (let i = 0; i < count; i += 1) {
        const angle = baseAngle + rng.range(-0.7, 0.7);
        const v = rng.range(120, 340);
        spawn({
          x, y,
          vx: Math.cos(angle) * v, vy: Math.sin(angle) * v,
          life: rng.range(0.12, 0.3), size: rng.range(1.5, 3), color, glow: true,
        });
      }
    },
    /** One soft drifting mote, for ambient starfield dust and core shimmer. */
    mote(x, y, color, rng) {
      spawn({
        x, y, vx: rng.range(-14, 14), vy: rng.range(-10, 22),
        life: rng.range(1.2, 2.6), size: rng.range(1, 2.4), color, drag: 0.1, round: true,
      });
    },
    update(dt) {
      for (let i = live.length - 1; i >= 0; i -= 1) {
        const p = live[i];
        p.life -= dt;
        if (p.life <= 0) {
          live[i] = live[live.length - 1];
          live.pop();
          pool.push(p);
          continue;
        }
        const damp = Math.max(0, 1 - p.drag * dt);
        p.vx *= damp;
        p.vy *= damp;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
      }
    },
    draw(ctx) {
      for (const p of live) {
        const alpha = Math.max(0, p.life / p.maxLife);
        ctx.globalAlpha = alpha;
        ctx.fillStyle = p.color;
        if (p.glow) {
          ctx.shadowColor = p.color;
          ctx.shadowBlur = 8;
        }
        if (p.round) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.size / 2, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
        }
        ctx.shadowBlur = 0;
      }
      ctx.globalAlpha = 1;
    },
    get count() {
      return live.length;
    },
    clear() {
      while (live.length) pool.push(live.pop());
    },
  };
}
