// Starfall Bastion — shared tuning constants: arena geometry, the neon palette and the
// balance numbers every other module reads. One place to tune the game's feel.

export const VIEW_WIDTH = 1280;
export const VIEW_HEIGHT = 720;

/** The bastion core sits at the arena centre; enemies cross the field to reach it. */
export const CORE_X = VIEW_WIDTH / 2;
export const CORE_Y = VIEW_HEIGHT / 2;
export const CORE_RADIUS = 34;
export const CORE_MAX_HP = 300;

/** Playfield margin: the player ship stays this far inside the arena walls. */
export const ARENA_MARGIN = 26;

export const PLAYER_RADIUS = 14;
export const PLAYER_MAX_HP = 100;
export const PLAYER_SPEED = 265;
export const PLAYER_HIT_INVULN_SECONDS = 0.6;

export const BULLET_SPEED = 640;
export const BULLET_RADIUS = 4;
export const BULLET_LIFE_SECONDS = 0.9;

/** Hull the Dreadnought chews through per second once it reaches the core. */
export const BOSS_CORE_DPS = 14;

export const SHARD_MAGNET_BASE = 90;
export const SHARD_ATTRACT_SPEED = 420;
export const SHARD_SCORE = 25;

/** Fixed simulation step: the world advances in 120 Hz slices so play is frame-rate proof. */
export const STEP = 1 / 120;

export const COLORS = {
  background: '#070b1d',
  backgroundDeep: '#04060f',
  gridLine: 'rgba(64, 96, 190, 0.16)',
  star: '#aebfff',
  player: '#57f7ff',
  playerCore: '#eaffff',
  bullet: '#ffe066',
  core: '#ffd166',
  coreRing: '#ff9f1c',
  chaser: '#ff4d8d',
  mini: '#ff8fb5',
  tank: '#ff8c42',
  splitter: '#7bf56a',
  dasher: '#4dd8ff',
  boss: '#c86bff',
  orb: '#ff5d5d',
  shard: '#8affd1',
  text: '#eaf6ff',
  textDim: '#8fa3c8',
  danger: '#ff5470',
  panel: 'rgba(10, 16, 38, 0.88)',
  panelEdge: '#3d5a99',
};
