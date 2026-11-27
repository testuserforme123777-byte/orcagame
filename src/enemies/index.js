/**
 * Instance-scoped enemy/boss encounter simulation using the shared app event bus.
 */
import { getDifficulty, enemyCountFor, DIFFICULTIES } from './difficulty.js';
import { createEnemy, createProjectile, createParticle } from './entities.js';
import { BOSS_DEFS, createBoss, runBossPattern, DEFEAT_ANIMATION_DURATION } from './bosses.js';

export { DIFFICULTIES, BOSS_DEFS };

export class EncounterSystem {
  constructor(bus, options = {}) {
    if (!bus || typeof bus.on !== 'function' || typeof bus.emit !== 'function') throw new TypeError('EncounterSystem requires a shared EventBus');
    const nextId = () => state.nextId++;
// Instance state (isolated per EncounterSystem)
// ---------------------------------------------------------------------------
const state = {
  events: bus,
  enemies: [],
  projectiles: [],
  particles: [],
  bosses: new Map(),        // boss ID -> boss
  activeBossId: null,
  stompEnabled: true,       // "optional stomp defeat"
  rng: options.rng ?? Math.random,
  contactGrace: options.contactGrace ?? 0.6,
  nextId: 1,
};


/** Configure this encounter instance. */
function configure({ stompEnabled, rng, contactGrace } = {}) {
  if (stompEnabled !== undefined) state.stompEnabled = !!stompEnabled;
  if (rng) state.rng = rng;
  if (contactGrace !== undefined) state.contactGrace = contactGrace;
}

// ---------------------------------------------------------------------------
// Enemies
// ---------------------------------------------------------------------------

/**
 * Spawn enemies for a level. Hard mode always spawns more than Easy.
 * @param {{level:number, difficulty:'easy'|'hard', platforms:Array<{x,y,w,h}>, rng?:Function}} opts
 * @returns {Array} the spawned enemies
 */
function spawnEnemies({ level, difficulty = 'easy', platforms = [], spawnPoints = [], rng = state.rng }) {
  if (!platforms.length) return [];
  const count = enemyCountFor(level, difficulty);
  const spawned = [];
  for (let i = 0; i < count; i++) {
    const point = spawnPoints.length ? spawnPoints[i % spawnPoints.length] : null;
    const plat = point ? (platforms[point.platform] ?? platforms[0]) : platforms[i % platforms.length];
    const roll = rng();
    let type = 'walker';
    if (level >= 4 && roll < 0.25) type = 'shooter';
    else if (level >= 2 && roll < 0.5) type = 'flyer';
    const margin = 20;
    const spanW = Math.max(plat.w - margin * 2, 10);
    const x = point ? point.x + (i >= spawnPoints.length ? (i % 3) * 34 : 0) : plat.x + margin + rng() * spanW;
    const y = point ? point.y : (type === 'flyer' ? plat.y - 120 : plat.y - 28);
    spawned.push(createEnemy(type, x, y, { level, difficulty, platform: plat, rng, idFactory: nextId }));
  }
  state.enemies.push(...spawned);
  return spawned;
}

/** Patrol + boundary turn + gravity/platform collision for one enemy. */
function updateEnemyMovement(e, dt, world) {
  if (e.type === 'flyer') {
    e.t += dt;
    e.x += e.dir * e.speed * dt;
    e.y += Math.sin(e.t * e.hoverFreq) * e.hoverAmp * dt * 8;
    if (e.x <= e.patrolMin) { e.x = e.patrolMin; e.dir = 1; }
    if (e.x + e.w >= e.patrolMax) { e.x = e.patrolMax - e.w; e.dir = -1; }
    return;
  }

  // Walkers & shooters: gravity + land on platform tops.
  e.vy += (world.gravity ?? 1200) * dt;
  e.y += e.vy * dt;
  for (const p of world.platforms) {
    const overlapping = e.x + e.w > p.x && e.x < p.x + p.w;
    const crossingTop = e.vy >= 0 && e.y + e.h >= p.y && e.y + e.h - e.vy * dt <= p.y + 4;
    if (overlapping && crossingTop) {
      e.y = p.y - e.h;
      e.vy = 0;
      // Boundary turn: reverse when reaching the edge of the platform we stand on.
      if (e.x <= e.patrolMin) { e.x = e.patrolMin; e.dir = 1; }
      if (e.x + e.w >= e.patrolMax) { e.x = e.patrolMax - e.w; e.dir = -1; }
      break;
    }
  }
  e.x += e.dir * e.speed * dt;
}

function overlaps(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/**
 * Advance enemies: movement, contact damage (with power-up protection via the
 * shared interface), stomp defeat, and player-projectile hit detection.
 * @param {number} dt seconds
 * @param {object} world { player, platforms, playerProjectiles?, gravity?, bounds? }
 */
function updateEnemies(dt, world) {
  const { player } = world;
  const playerBounds = typeof player.getBounds === 'function' ? player.getBounds() : player;

  for (const e of state.enemies) {
    if (e.dead) continue;
    updateEnemyMovement(e, dt, world);
    e.hitFlash = Math.max(0, e.hitFlash - dt);
    e.touchCooldown = Math.max(0, e.touchCooldown - dt);

    // --- Contact damage & stomp ---
    if (e.touchCooldown <= 0 && overlaps(e, playerBounds)) {
      const falling = typeof player.vy === 'number' && player.vy > 0;
      if (state.stompEnabled && falling && playerBounds.y + playerBounds.h - e.y < e.h * 0.5) {
        stompEnemy(e, player); // optional stomp defeat; does not own player bounce physics
      } else if (!(typeof player.isInvulnerable === 'function' && player.isInvulnerable())) {
        // Power-up protection honored through the shared interface.
        e.touchCooldown = state.contactGrace;
        emitPlayerDamage(world, getDifficulty(e.difficultyKey || 'easy').contactDamage, { source: 'contact', enemyType: e.type });
      }
    }

    // --- Shooter attack: fire an enemy projectile at the player ---
    if (e.type === 'shooter') {
      e.fireTimer -= dt;
      const pcx = playerBounds.x + playerBounds.w / 2;
      const dist = Math.abs(pcx - (e.x + e.w / 2));
      if (e.fireTimer <= 0 && dist < e.range) {
        e.fireTimer = e.fireCooldown;
        const dir = Math.sign(pcx - e.x) || 1;
        const d = getDifficulty(e.difficultyKey || 'easy');
        state.projectiles.push(createProjectile(e.x + e.w / 2, e.y + 8, dir * d.projectileSpeed, -40,
          { owner: 'enemy', damage: 1, color: '#8ef08e', idFactory: nextId }));
      }
    }
  }

  // --- Player projectiles vs enemies ---
  const playerProjectiles = world.playerProjectiles || [];
  for (const proj of playerProjectiles) {
    if (proj.consumed) continue;
    for (const e of state.enemies) {
      if (e.dead) continue;
      const box = { x: e.x, y: e.y, w: e.w, h: e.h };
      const pb = { x: proj.x - proj.radius, y: proj.y - proj.radius, w: proj.radius * 2, h: proj.radius * 2 };
      if (overlaps(box, pb)) {
        proj.consumed = true;
        damageEnemy(e, proj.damage, { source: 'player-projectile' });
        break;
      }
    }
  }

  updateProjectiles(dt, world);
  updateParticles(dt);
}

/** Defeat by stomp. Emits 'enemy.stomped' so the player controller can bounce. */
function stompEnemy(e, player) {
  e.hp = 0;
  defeatEnemy(e, { cause: 'stomp' });
  state.events.emit('enemy.stomped', { enemyId: e.id, enemyType: e.type });
}

/** Apply damage to an enemy; handles defeat effects + event. Exposed per spec. */
function damageEnemy(enemy, amount, meta = {}) {
  if (!enemy || enemy.dead) return false;
  enemy.hp -= amount;
  enemy.hitFlash = 0.12;
  if (enemy.hp <= 0) {
    defeatEnemy(enemy, meta);
    return true;
  }
  state.events.emit('enemy.damaged', { enemyId: enemy.id, amount, ...meta });
  return false;
}

function defeatEnemy(e, meta = {}) {
  if (e.dead) return;
  e.dead = true;
  for (let i = 0; i < 10; i++) {
    state.particles.push(createParticle(e.x + e.w / 2, e.y + e.h / 2, e.palette, state.rng));
  }
  state.events.emit('enemy.defeated', { enemyId: e.id, enemyType: e.type, x: e.x, y: e.y, ...meta });
}

function emitPlayerDamage(world, amount, meta) {
  const applied = typeof world.player.onDamaged === 'function'
    ? world.player.onDamaged(amount, meta.source) === true
    : false;
  // Report only successful damage; invulnerability and protection must not cost lives.
  if (applied) state.events.emit('player.damaged', { amount, ...meta, applied: true });
}

// ---------------------------------------------------------------------------
// Bosses
// ---------------------------------------------------------------------------

/**
 * Spawn the boss for a world (bosses belong to worlds 1-5, met after levels 3, 6, 9, 12, 15).
 * Hard boss health is exactly twice Easy boss health (guaranteed).
 * @param {{world:number, difficulty:'easy'|'hard', arena:{x,y,w,h}}} opts
 */
function spawnBoss({ bossId, difficulty = 'easy', arena }) {
  if (!BOSS_DEFS[bossId]) throw new Error(`spawnBoss: unknown boss ID ${bossId}.`);
  const boss = createBoss(bossId, difficulty, arena);
  state.bosses.set(bossId, boss);
  state.activeBossId = bossId;
  return boss;
}

function resolveBoss(target) {
  if (typeof target === 'string') return state.bosses.get(target) || null;
  if (typeof target === 'number') return null; // world-number aliases are deliberately unsupported
  if (target && typeof target === 'object' && target.def) return state.bosses.get(target.id) || target;
  if (state.activeBossId != null) return state.bosses.get(state.activeBossId) || null;
  return null;
}

/** Apply damage to a boss. Accepts a boss object, a world number, or nothing (active boss). */
function damageBoss(target, amount, meta = {}) {
  const boss = resolveBoss(target);
  if (!boss || boss.defeated) return false;
  boss.health = Math.max(0, boss.health - amount);
  boss.hitFlash = 0.12;
  if (boss.health <= boss.maxHealth / 2) boss.phase = 2;
  state.events.emit('boss.damaged', { bossId: boss.id, world: boss.world, health: boss.health, maxHealth: boss.maxHealth, ...meta });

  if (boss.health <= 0) {
    boss.defeated = true;
    boss.defeatTimer = DEFEAT_ANIMATION_DURATION;
    boss.vx = 0;
    // 'boss.defeating' = animation starts; 'boss.defeated' fires when the animation finishes.
    state.events.emit('boss.defeating', { bossId: boss.id, world: boss.world });
    for (let i = 0; i < 24; i++) {
      state.particles.push(createParticle(boss.x + boss.w / 2, boss.y + boss.h / 2, boss.def.accent, state.rng));
    }
    return true;
  }
  return false;
}

/**
 * Advance the active/specified boss: movement, attack pattern, defeat animation.
 * @param {number} dt
 * @param {object} world { player, platforms, gravity?, bounds }
 */
function updateBoss(dt, world) {
  const boss = state.activeBossId != null ? state.bosses.get(state.activeBossId) : null;
  if (!boss) return;
  boss.hitFlash = Math.max(0, boss.hitFlash - dt);

  if (boss.defeated) {
    // Defeat animation: shake, sink and fade out; then emit the final event.
    boss.defeatTimer -= dt;
    boss.y += 30 * dt;
    boss.x += Math.sin(boss.defeatTimer * 40) * 2;
    if (boss.defeatTimer <= 0 && !boss.defeatEventSent) {
      boss.defeatEventSent = true;
      state.events.emit('boss.defeated', { bossId: boss.id, world: boss.world });
    }
    return;
  }

  // Patrol back and forth across the arena; dash overrides patrol velocity.
  const { arena } = boss;
  const patrolling = !boss.dashState;
  if (patrolling) {
    boss.x += boss.def.walkSpeed * boss.dir * dt;
    if (boss.x <= arena.x + 8) boss.dir = 1;
    if (boss.x + boss.w >= arena.x + arena.w - 8) boss.dir = -1;
  } else if (boss.dashState?.phase === 'dashing') {
    boss.dashState.timer -= dt;
    boss.x += boss.vx * dt;
    boss.x = Math.max(arena.x + 8, Math.min(boss.x, arena.x + arena.w - boss.w - 8));
    if (boss.dashState.timer <= 0) { boss.vx = 0; boss.dashState = null; }
  } else if (boss.dashState?.phase === 'telegraph') {
    boss.dashState.timer -= dt;
  }

  runBossPattern(boss, dt, {
    fireProjectile: (x, y, vx, vy, opts) => state.projectiles.push(createProjectile(x, y, vx, vy, { ...opts, idFactory: nextId })),
    spawnMinion: (type, x, y) => {
      const e = createEnemy(type, x, y, { difficulty: boss.difficultyKey, platform: null, rng: state.rng, idFactory: nextId });
      e.patrolMin = arena.x; e.patrolMax = arena.x + arena.w - e.w;
      state.enemies.push(e);
    },
    playerBounds: typeof world.player.getBounds === 'function' ? world.player.getBounds() : world.player,
    rng: state.rng,
  });

  // Boss is damaged by player projectiles.
  const playerProjectiles = world.playerProjectiles || [];
  for (const proj of playerProjectiles) {
    if (proj.consumed) continue;
    const pb = { x: proj.x - proj.radius, y: proj.y - proj.radius, w: proj.radius * 2, h: proj.radius * 2 };
    if (overlaps(boss, pb)) {
      proj.consumed = true;
      damageBoss(boss, proj.damage, { source: 'player-projectile' });
    }
  }
}

/** True once the boss for the given world (or the active boss) has 0 HP. */
function isBossDefeated(bossId = state.activeBossId) {
  const boss = state.bosses.get(bossId);
  return !!boss && boss.health <= 0;
}

/** Get the boss object (for rendering the health bar or custom logic). */
function getBoss(bossId = state.activeBossId) {
  return state.bosses.get(bossId) || null;
}

// ---------------------------------------------------------------------------
// Projectiles & particles
// ---------------------------------------------------------------------------

function updateProjectiles(dt, world) {
  const playerBounds = typeof world.player.getBounds === 'function' ? world.player.getBounds() : world.player;
  const bounds = world.bounds || { w: Infinity, h: Infinity };

  for (const p of state.projectiles) {
    if (p.consumed) continue;
    p.vy += (p.gravity || 0) * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.ttl -= dt;
    if (p.ttl <= 0 || p.x < -50 || p.x > bounds.w + 50 || p.y > bounds.h + 50) p.consumed = true;

    // Enemy projectiles hit the player (respecting power-up protection).
    if (p.owner === 'enemy' && !p.consumed) {
      const pb = { x: p.x - p.radius, y: p.y - p.radius, w: p.radius * 2, h: p.radius * 2 };
      if (overlaps(playerBounds, pb) && !(typeof world.player.isInvulnerable === 'function' && world.player.isInvulnerable())) {
        p.consumed = true;
        emitPlayerDamage(world, p.damage, { source: 'enemy-projectile' });
      }
    }
  }
  state.projectiles = state.projectiles.filter(p => !p.consumed);
}

function updateParticles(dt) {
  for (const pt of state.particles) {
    pt.vy += 500 * dt;
    pt.x += pt.vx * dt;
    pt.y += pt.vy * dt;
    pt.life -= dt;
  }
  state.particles = state.particles.filter(p => p.life > 0);
}

// ---------------------------------------------------------------------------
// Rendering (canvas 2d)
// ---------------------------------------------------------------------------

/** Render enemies, projectiles, particles, and the boss + its health bar. */
function renderEnemies(g, camera = { x: 0, y: 0 }) {
  if (!g) return;

  // Particles
  for (const pt of state.particles) {
    g.globalAlpha = Math.max(0, pt.life / pt.maxLife);
    g.fillStyle = pt.color;
    g.fillRect(pt.x - pt.size / 2, pt.y - pt.size / 2, pt.size, pt.size);
  }
  g.globalAlpha = 1;

  // Projectiles
  for (const p of state.projectiles) {
    g.fillStyle = p.color;
    g.beginPath();
    g.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
    g.fill();
  }

  // Enemies
  for (const e of state.enemies) {
    if (e.dead) continue;
    g.fillStyle = e.hitFlash > 0 ? '#ffffff' : e.palette;
    g.fillRect(e.x, e.y, e.w, e.h);
    // eyes face travel direction
    g.fillStyle = '#fff';
    const ex = e.dir > 0 ? e.x + e.w - 10 : e.x + 4;
    g.fillRect(ex, e.y + 5, 3, 6);
    g.fillRect(ex + (e.dir > 0 ? 4 : -6), e.y + 5, 3, 6);
  }

  // Boss
  const boss = getBoss();
  if (boss) {
    const alpha = boss.defeated ? Math.max(0, boss.defeatTimer / DEFEAT_ANIMATION_DURATION) : 1;
    g.globalAlpha = alpha;
    g.save();
    g.translate(boss.x + boss.w / 2, boss.y + boss.h / 2);
    g.fillStyle = boss.hitFlash > 0 ? '#fff' : boss.def.color;
    g.strokeStyle = boss.def.accent;
    g.lineWidth = 4;
    const hw = boss.w / 2, hh = boss.h / 2;
    const body = boss.hitFlash > 0 ? '#fff' : boss.def.color;
    const detail = boss.def.accent;
    const stroke = (width = 3) => { g.lineWidth = width; g.lineJoin = 'round'; g.lineCap = 'round'; };
    const path = (points, close = true) => {
      g.beginPath();
      points.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y));
      if (close) g.closePath();
      g.fill(); g.stroke();
    };
    g.fillStyle = body;
    g.strokeStyle = detail;
    stroke(3);
    switch (boss.def.shape) {
      case 'brute': { // Coral Warden: broad crab-knight with a shell and pincers.
        g.fillStyle = detail;
        path([[-hw*.72,-hh*.08],[-hw-12,-hh*.55],[-hw-18,-hh*.25],[-hw*.78,hh*.18]]);
        path([[hw*.72,-hh*.08],[hw+12,-hh*.55],[hw+18,-hh*.25],[hw*.78,hh*.18]]);
        g.fillStyle = body;
        path([[-hw*.72,-hh*.42],[-hw*.48,-hh*.82],[0,-hh*.96],[hw*.48,-hh*.82],[hw*.72,-hh*.42],[hw*.65,hh*.52],[0,hh*.78],[-hw*.65,hh*.52]]);
        g.fillStyle = detail;
        path([[-hw*.52,-hh*.65],[-hw*.22,-hh*.94],[0,-hh*.68],[hw*.22,-hh*.94],[hw*.52,-hh*.65],[0,-hh*.48]]);
        g.fillStyle = body;
        for (const side of [-1,1]) {
          g.beginPath(); g.moveTo(side*hw*.55,hh*.2); g.lineTo(side*hw*.92,hh*.48); g.lineTo(side*hw*.7,hh*.64); g.lineTo(side*hw*.42,hh*.48); g.closePath(); g.fill(); g.stroke();
        }
        break;
      }
      case 'crystal': { // Ruin Colossus: faceted golem with shoulder shards.
        g.fillStyle = detail;
        path([[-hw*.72,-hh*.42],[-hw-7,-hh*.78],[-hw*.42,-hh*.62],[-hw*.2,-hh*.92],[0,-hh*.7],[hw*.2,-hh*.92],[hw*.42,-hh*.62],[hw+7,-hh*.78],[hw*.72,-hh*.42]]);
        g.fillStyle = body;
        path([[-hw*.56,-hh*.62],[-hw*.28,-hh],[hw*.18,-hh*.94],[hw*.58,-hh*.54],[hw*.48,hh*.62],[0,hh],[ -hw*.5,hh*.58]]);
        g.fillStyle = detail;
        path([[-hw*.28,-hh*.78],[0,-hh*.42],[hw*.22,-hh*.78],[hw*.08,-hh*.2],[0,hh*.22],[-hw*.12,-hh*.18]]);
        g.fillStyle = body;
        path([[-hw*.45,hh*.35],[-hw*.72,hh*.78],[-hw*.2,hh*.7]]);
        path([[hw*.45,hh*.35],[hw*.72,hh*.78],[hw*.2,hh*.7]]);
        break;
      }
      case 'serpent': { // Abyss Emperor: long sea-dragon head, horns and fins.
        g.fillStyle = detail;
        path([[-hw*.58,-hh*.28],[-hw*.92,-hh*.95],[-hw*.18,-hh*.62],[-hw*.05,-hh*.95],[hw*.2,-hh*.58],[hw*.78,-hh*.82],[hw*.52,-hh*.12]]);
        g.fillStyle = body;
        g.beginPath(); g.ellipse(0,0,hw*.86,hh*.62,0,0,Math.PI*2); g.fill(); g.stroke();
        g.fillStyle = detail;
        path([[hw*.35,-hh*.18],[hw*.98,0],[hw*.36,hh*.34],[hw*.62,hh*.08]]);
        path([[-hw*.48,hh*.12],[-hw*.88,hh*.68],[-hw*.2,hh*.42]]);
        // layered neck scales
        for(let i=0;i<4;i++){ g.beginPath(); g.arc(-hw*.42+i*13,hh*.18,5,0,Math.PI); g.stroke(); }
        break;
      }
      case 'warden': { // Kelp Guardian: armored plant sentinel with branching antlers.
        g.fillStyle = detail;
        path([[-hw*.48,-hh*.55],[-hw*.95,-hh*.98],[-hw*.78,-hh*.38],[-hw*.38,-hh*.2]]);
        path([[hw*.48,-hh*.55],[hw*.95,-hh*.98],[hw*.78,-hh*.38],[hw*.38,-hh*.2]]);
        g.fillStyle = body;
        path([[-hw*.56,-hh*.48],[-hw*.4,-hh*.9],[hw*.4,-hh*.9],[hw*.56,-hh*.48],[hw*.48,hh*.62],[0,hh*.9],[-hw*.48,hh*.62]]);
        g.fillStyle = detail;
        path([[-hw*.3,-hh*.72],[0,-hh*.96],[hw*.3,-hh*.72],[hw*.18,-hh*.34],[0,-hh*.48],[-hw*.18,-hh*.34]]);
        // leafy shoulder plates and root legs
        path([[-hw*.52,-hh*.12],[-hw*.98,hh*.12],[-hw*.72,hh*.48],[-hw*.38,hh*.28]]);
        path([[hw*.52,-hh*.12],[hw*.98,hh*.12],[hw*.72,hh*.48],[hw*.38,hh*.28]]);
        g.fillStyle = body;
        path([[-hw*.42,hh*.52],[-hw*.55,hh*.94],[-hw*.08,hh*.78]]);
        path([[hw*.42,hh*.52],[hw*.55,hh*.94],[hw*.08,hh*.78]]);
        break;
      }
      case 'sovereign': { // Ice Leviathan: crowned armored sea-beast with dorsal spikes.
        g.fillStyle = detail;
        path([[-hw*.68,-hh*.48],[-hw*.92,-hh*.98],[-hw*.42,-hh*.72],[-hw*.18,-hh],[0,-hh*.68],[hw*.18,-hh],[hw*.42,-hh*.72],[hw*.92,-hh*.98],[hw*.68,-hh*.48]]);
        g.fillStyle = body;
        path([[-hw*.68,-hh*.48],[-hw*.42,-hh*.82],[hw*.42,-hh*.82],[hw*.68,-hh*.48],[hw*.82,hh*.38],[hw*.38,hh*.88],[-hw*.38,hh*.88],[-hw*.82,hh*.38]]);
        g.fillStyle = detail;
        path([[-hw*.55,-hh*.4],[0,-hh*.66],[hw*.55,-hh*.4],[hw*.35,hh*.48],[0,hh*.68],[-hw*.35,hh*.48]]);
        // icy cheek fins
        path([[-hw*.62,-hh*.04],[-hw-8,hh*.28],[-hw*.58,hh*.48]]);
        path([[hw*.62,-hh*.04],[hw+8,hh*.28],[hw*.58,hh*.48]]);
        break;
      }
    }
    // Face: expressive eyes, brow ridges and a visible jaw/mouth on every boss.
    g.fillStyle = boss.def.eyeColor;
    g.beginPath(); g.ellipse(-boss.w*.18,-hh*.2,7,10,-.18,0,Math.PI*2); g.fill();
    g.beginPath(); g.ellipse(boss.w*.12,-hh*.2,7,10,.18,0,Math.PI*2); g.fill();
    g.fillStyle = '#17212b';
    g.beginPath(); g.arc(-boss.w*.17,-hh*.2,3,0,Math.PI*2); g.fill();
    g.beginPath(); g.arc(boss.w*.13,-hh*.2,3,0,Math.PI*2); g.fill();
    g.strokeStyle = '#17212b'; stroke(3);
    g.beginPath(); g.moveTo(-hw*.28,hh*.22); g.quadraticCurveTo(0,hh*.43,hw*.28,hh*.22); g.stroke();
    g.fillStyle = '#f7f2dc';
    g.beginPath(); g.moveTo(-hw*.12,hh*.25); g.lineTo(-hw*.06,hh*.38); g.lineTo(0,hh*.26); g.lineTo(hw*.06,hh*.38); g.lineTo(hw*.12,hh*.25); g.closePath(); g.fill();
    g.restore();

    // Health bar (top of screen, centered)
    const bw = 320, bh = 18;
    const bx = (g.canvas?.width ?? 800) / 2 - bw / 2;
    const by = 24;
    g.globalAlpha = 1;
    g.fillStyle = '#222';
    g.fillRect(bx + (camera?.x ?? 0) - 2, by + (camera?.y ?? 0) - 2, bw + 4, bh + 4);
    g.fillStyle = '#444';
    g.fillRect(bx + (camera?.x ?? 0), by + (camera?.y ?? 0), bw, bh);
    g.fillStyle = boss.def.accent;
    g.fillRect(bx + (camera?.x ?? 0), by + (camera?.y ?? 0), bw * Math.max(0, boss.health / boss.maxHealth), bh);
    g.fillStyle = '#fff';
    g.font = 'bold 12px sans-serif';
    g.textAlign = 'center';
    g.fillText(`${boss.def.name}`, bx + (camera?.x ?? 0) + bw / 2, by + (camera?.y ?? 0) + 13);
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/** Remove all enemies, projectiles, particles, and bosses (e.g. on level restart). */
function clearEnemies() {
  state.enemies = [];
  state.projectiles = [];
  state.particles = [];
  state.bosses.clear();
  state.activeBossId = null;
}

/**
 * Capture the active encounter as plain JSON data for portable saves.
 * Static boss definitions are referenced by world number and reattached on restore.
 */
function serializeEncounter() {
  const fields = {
    enemy: ['id','type','x','y','vx','vy','dead','hitFlash','touchCooldown','t','difficultyKey','palette','w','h','hp','speed','dir','patrolMin','patrolMax','hoverAmp','hoverFreq','fireCooldown','fireTimer','range'],
    projectile: ['id','x','y','vx','vy','owner','damage','radius','gravity','color','ttl'],
    particle: ['x','y','vx','vy','life','maxLife','size','color'],
    boss: ['id','world','arena','x','y','vx','vy','dir','w','h','health','maxHealth','attackTimer','dashState','teleportCooldown','minionsSpawned','phase','defeated','defeatTimer','hitFlash','difficultyKey','defeatEventSent','attackCount']
  };
  const pick = (value, keys) => Object.fromEntries(keys.filter(key => value[key] !== undefined).map(key => [key, value[key]]));
  return {
    schemaVersion: 3,
    enemies: state.enemies.map(value => pick(value, fields.enemy)),
    projectiles: state.projectiles.map(value => pick(value, fields.projectile)),
    particles: state.particles.map(value => pick(value, fields.particle)),
    bosses: [...state.bosses.values()].map(value => pick(value, fields.boss)),
    activeBossId: state.activeBossId
  };
}

/** Restore a previously validated encounter snapshot after the target level is spawned. */
function validateEncounterSnapshot(snapshot) {
  if (!snapshot || snapshot.schemaVersion !== 3 || !Array.isArray(snapshot.enemies) ||
      !Array.isArray(snapshot.projectiles) || !Array.isArray(snapshot.particles) ||
      !Array.isArray(snapshot.bosses)) throw new TypeError('Invalid encounter snapshot');
  if (snapshot.enemies.length > 250 || snapshot.projectiles.length > 500 ||
      snapshot.particles.length > 1000 || snapshot.bosses.length > 1) {
    throw new RangeError('Encounter snapshot exceeds entity limits');
  }
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const ids = [];
  for (const enemy of snapshot.enemies) {
    if (!enemy || !Number.isSafeInteger(enemy.id) || enemy.id < 0 ||
        !['walker','flyer','shooter'].includes(enemy.type) ||
        !['x','y','vx','vy','w','h','hp','speed','dir'].every(key => finite(enemy[key])) ||
        typeof enemy.dead !== 'boolean' || !['easy','hard'].includes(enemy.difficultyKey) ||
        typeof enemy.palette !== 'string' ||
        !['patrolMin','patrolMax'].every(key => finite(enemy[key])) ||
        (enemy.type === 'flyer' && !['hoverAmp','hoverFreq'].every(key => finite(enemy[key]))) ||
        (enemy.type === 'shooter' && !['fireCooldown','fireTimer','range'].every(key => finite(enemy[key])))) {
      throw new TypeError('Encounter contains an invalid enemy');
    }
    ids.push(enemy.id);
  }
  for (const projectile of snapshot.projectiles) {
    if (!projectile || !Number.isSafeInteger(projectile.id) || projectile.id < 0 ||
        !['x','y','vx','vy','radius','ttl','damage','gravity'].every(key => finite(projectile[key])) ||
        !['player','enemy'].includes(projectile.owner) || typeof projectile.color !== 'string') {
      throw new TypeError('Encounter contains an invalid projectile');
    }
    ids.push(projectile.id);
  }
  if (new Set(ids).size !== ids.length) throw new TypeError('Encounter entity IDs must be unique');
  for (const particle of snapshot.particles) {
    if (!particle || !['x','y','vx','vy','life','maxLife','size'].every(key => finite(particle[key])) ||
        typeof particle.color !== 'string') throw new TypeError('Encounter contains an invalid particle');
  }
  for (const boss of snapshot.bosses) {
    if (!boss || typeof boss.id !== 'string' || !BOSS_DEFS[boss.id] || BOSS_DEFS[boss.id].world !== boss.world || !boss.arena ||
        !['x','y','w','h'].every(key => finite(boss.arena[key])) ||
        !['x','y','vx','vy','health','maxHealth','attackTimer','defeatTimer','dir','w','h','teleportCooldown','minionsSpawned','hitFlash'].every(key => finite(boss[key])) ||
        !['easy','hard'].includes(boss.difficultyKey) || ![1,2].includes(boss.phase) ||
        typeof boss.defeated !== 'boolean' ||
        (boss.defeatEventSent !== undefined && typeof boss.defeatEventSent !== 'boolean') ||
        (boss.dashState !== null && boss.dashState !== undefined &&
          (!['telegraph','dashing'].includes(boss.dashState.phase) || !finite(boss.dashState.timer)))) {
      throw new TypeError('Encounter contains an invalid boss');
    }
  }
  if (snapshot.activeBossId !== null && snapshot.activeBossId !== undefined &&
      (typeof snapshot.activeBossId !== 'string' || !snapshot.bosses.some(boss => boss.id === snapshot.activeBossId))) {
    throw new TypeError('Encounter active boss reference is invalid');
  }
  return true;
}

function restoreEncounter(snapshot) {
  validateEncounterSnapshot(snapshot);
  state.enemies = JSON.parse(JSON.stringify(snapshot.enemies));
  state.projectiles = JSON.parse(JSON.stringify(snapshot.projectiles));
  state.particles = JSON.parse(JSON.stringify(snapshot.particles));
  state.bosses = new Map(snapshot.bosses.map(snapshotBoss => [
    snapshotBoss.id,
    { ...JSON.parse(JSON.stringify(snapshotBoss)), def: BOSS_DEFS[snapshotBoss.id] }
  ]));
  state.activeBossId = snapshot.activeBossId ?? null;
  const ids = [...state.enemies, ...state.projectiles].map(entity => entity.id).filter(Number.isInteger);
  state.nextId = Math.max(state.nextId, 1, ...ids.map(id => id + 1));
  return true;
}

/** Read-only enemy list used by world collision resolution. */
function getEnemiesForCollision() { return state.enemies; }


    Object.assign(this, { configure, spawnEnemies, updateEnemies, damageEnemy, spawnBoss, damageBoss, updateBoss, isBossDefeated, getBoss, renderEnemies, clearEnemies, serializeEncounter, validateEncounterSnapshot, restoreEncounter, getEnemiesForCollision });
  }
}
