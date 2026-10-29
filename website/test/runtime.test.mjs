import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { generate } from '../src/generator/index.mjs';
import { testMath } from '../vendor/simple-ragdoll/src/core/program.mjs';
import { script } from './molangeval.mjs';
import { pack } from './fixtures.mjs';

test('packaged scripts hand off the live pose once, inherit delayed motion and do no live/UI physics', async () => {
  const result = await generate(await pack(), 'demo.mcpack'), zip = await JSZip.loadAsync(result.download.data);
  const c = JSON.parse(await zip.file('entity/demo0.entity.json').async('string'))['minecraft:client_entity'].description;
  const animations = {};
  for (const f of Object.values(zip.files)) if (!f.dir && f.name.startsWith('animations/')) Object.assign(animations, JSON.parse(await f.async('string')).animations);
  const math = { ...testMath, random: (a, b) => (a + b) / 2 };
  function simulate(impact, ui = false) {
    let reads = 0, updates = 0, first = null, active = 0;
    const v = new Proxy({}, { get: (o, k) => k in o ? o[k] : 0 });
    const q = { is_in_ui: +ui, is_baby: 0, is_alive: 1, life_time: 0, delta_time: 0, death_ticks: 0, body_y_rotation: 0, frame_alpha: 1, model_scale: 0.0625,
      position: a => a === 1 ? 10 : a === 0 && impact ? 6 * Math.max(0, q.life_time - 0.625) : 0,
      bone_orientation_trs: name => { reads++; assert(['body', 'head'].includes(name)); return { t: { x: 0, y: name === 'body' ? 12 : 20, z: 0 }, r: { x: 0, y: name === 'head' ? 30 : 0, z: 0 }, s: { x: 1, y: 1, z: 1 } }; },
      block_has_any_tag: () => 0, relative_block_has_any_tag: () => 0,
    };
    const run = s => script(s)(v, {}, q, math, {});
    const value = s => typeof s === 'number' ? s : run(s.includes(';') ? s : 'return ' + s + ';');
    c.scripts.initialize.forEach(run);
    const bones = animations[c.animations.ragdoll_generated].bones;
    for (let i = 0; i <= 60; i++) {
      q.life_time = i / 60; q.delta_time = i ? 1 / 60 : 0; q.is_alive = +(i < 36); q.death_ticks = q.is_alive ? 0 : Math.floor((i - 36) / 3);
      c.scripts.pre_animation.forEach(run);
      if (v.vr_motion_pending) { updates++; assert(impact); assert(v.vr_motion_kickx > 1); }
      // Also evaluate at zero animation weight: the kernel itself must guard its queries.
      for (const call of c.scripts.animate) for (const alias of Object.keys(call)) if (alias.startsWith('ragdoll_compute_')) run(animations[c.animations[alias]].anim_time_update);
      if (i < 36 || ui) { assert.equal(reads, 0); assert.equal(v.ragdoll_active, 0); }
      if (v.ragdoll_active && !active) { first = value(bones.head.rotation[1]); active++; }
      for (const b of Object.values(bones)) for (const ch of Object.values(b)) for (const s of ch) assert(Number.isFinite(value(s)));
    }
    return { v, reads, updates, first, active, rootX: value(bones.body.position[0]) };
  }
  const still = simulate(false), hit = simulate(true), ui = simulate(true, true);
  assert.equal(still.reads, 2); assert.equal(hit.reads, 2); assert.equal(hit.active, 1);
  assert(Math.abs(hit.first - 30) < 1e-6, 'Head must retain its last animated yaw');
  assert.equal(still.updates, 0); assert.equal(hit.updates, 1); assert.equal(ui.updates, 0);
  assert.equal(ui.active, 0); assert.equal(ui.rootX, 0);
  assert.equal(+hit.v.vr_motion_done, 1); assert.equal(+hit.v.vr_motion_pending, 0);
  assert.notEqual(hit.rootX, still.rootX);
});
