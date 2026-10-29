import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { waterStep } from '../src/generator/water-buoyancy.mjs';
import { emit } from '../vendor/simple-ragdoll/src/core/expression.mjs';
import { testMath } from '../vendor/simple-ragdoll/src/core/program.mjs';
import { generate } from '../src/generator/index.mjs';
import { script } from './molangeval.mjs';
import { pack, client, vanillaClient } from './fixtures.mjs';

test('two-point buoyancy lifts, damps and turns immersed bodies while preserving dry motion and sleep', () => {
  const shape = { body: 0, center: [0, 0, 0], half: [8, 4, 4], quaternion: [0, 0, 0, 1] };
  const rig = { bodies: [{ mass: 10, inverseMass: .1, inverseInertia: [.01, .01, .01], shapes: [shape] }], shapes: [shape], joints: [], simulation: { frequency: 20, sleep: { seconds: 1, checkInterval: .5 } } };
  for (const absolute of [false, true]) {
    const run = script(emit(waterStep(rig, { absolute })));
    const state = () => ({ body_units: 1, body_units2: 1, body_units3: 1, tick: 1, sleep: 0, gravity_x: 0, gravity_y: -9.81, gravity_z: 0,
      ox: 0, oy: 0, oz: 0, ex: 0, ey: 0, ez: 0, b0x: 0, b0y: 0, b0z: 0, b0qx: 0, b0qy: 0, b0qz: 0, b0qw: 1,
      b0vx: 1, b0vy: 0, b0vz: 0, b0wx: 0, b0wy: 1, b0wz: 0 });
    function step(water, changes = {}) {
      const v = { ...state(), ...changes }, positions = [];
      const q = { [absolute ? 'block_has_any_tag' : 'relative_block_has_any_tag']: (x, y, z, ...tags) => {
        if (tags.includes('water')) { positions.push([x, y, z]); return +water(x, y, z); }
        assert.deepEqual(tags, ['lava']); return 0;
      } };
      run(v, {}, q, testMath, {}); return { v, positions };
    }
    const dry = step(() => false); assert.deepEqual(dry.v, state()); assert.equal(dry.positions.length, 2);
    const full = step(() => true); assert(full.v.b0vy > 9.81 / 20); assert(full.v.b0vx < 1); assert(full.v.b0wy < 1); assert.equal(full.v.b0wz, 0);
    const half = step(x => x < 0); assert(half.v.b0vy > 0 && half.v.b0vy < full.v.b0vy); assert(half.v.b0wz < 0);
    const shifted = step(x => x < (absolute ? 150 : 0), { ox: 150, ex: 150 });
    for (const key of ['b0vx', 'b0vy', 'b0wz']) assert.equal(shifted.v[key], half.v[key]);
    assert.equal(step(() => true, { sleep: 20, tick: 1 }).positions.length, 0);
    assert.equal(step(() => true, { sleep: 20, tick: 10 }).v.sleep, 0);
    // Captured model scale and orientation must move sample points with the body.
    const scaled = step(() => false, { body_units: 4, body_units2: 16, body_units3: 64 });
    assert.deepEqual(scaled.positions, [[-1, 0, 0], [1, 0, 0]]);
    const turned = step(() => false, { body_units: 8, body_units2: 64, body_units3: 512, b0qz: Math.SQRT1_2, b0qw: Math.SQRT1_2 });
    assert(turned.positions[0][1] < 0 && turned.positions[1][1] > 0);
  }
});

test('downloaded custom and vanilla-model patches execute water physics only during ragdolls', async () => {
  const iron = client('demo:metal_mob');
  iron['minecraft:client_entity'].description.geometry = { default: 'geometry.irongolem' };
  const result = await generate(await pack({ clients: [client(), vanillaClient(), iron] }), 'water.mcpack');
  assert.equal(result.successful, 3, JSON.stringify(result.reports));
  const zip = await JSZip.loadAsync(result.download.data), animations = {};
  for (const f of Object.values(zip.files)) if (!f.dir && f.name.startsWith('animations/')) Object.assign(animations, JSON.parse(await f.async('string')).animations);
  for (const path of ['entity/demo0.entity.json', 'entity/demo1.entity.json', 'entity/demo2.entity.json']) {
    const c = JSON.parse(await zip.file(path).async('string'))['minecraft:client_entity'].description;
    function simulate(liquid, ui = false) {
      let queries = 0, name = '';
      const v = new Proxy({}, { get: (o, k) => k in o ? o[k] : 0 });
      const q = { is_name_any: expected => +(name === expected), is_in_ui: +ui, is_alive: 1, is_baby: 0,
        life_time: 0, delta_time: 1 / 60, frame_alpha: 1, model_scale: .0625, death_ticks: 0, body_y_rotation: 0,
        position: a => a === 1 ? 10 : 0,
        bone_orientation_trs: bone => ({ t: { x: 0, y: bone === 'head' ? 20 : 12, z: 0 }, r: { x: 0, y: 0, z: 0 }, s: { x: 1, y: 1, z: 1 } }),
        relative_block_has_any_tag: (x, y, z, ...tags) => {
          if (tags.includes('water') || tags.includes('lava')) { queries++; return +tags.includes(liquid); }
          return 0;
        },
      };
      const math = { ...testMath, random: (a, b) => (a + b) / 2 }, run = s => script(s)(v, {}, q, math, {});
      const value = s => typeof s === 'number' ? s : run(s.includes(';') ? s : 'return ' + s + ';');
      c.scripts.initialize.forEach(run);
      const frame = () => {
        q.life_time += q.delta_time; c.scripts.pre_animation.forEach(run);
        for (const call of c.scripts.animate) for (const alias of typeof call === 'string' ? [call] : Object.keys(call)) {
          // Deliberately eager: animation guards must protect zero-weight calls too.
          const code = animations[c.animations[alias]]?.anim_time_update; if (code) run(code);
        }
      };
      for (let i = 0; i < 5; i++) frame(); assert.equal(queries, 0, 'No water reads while alive');
      name = 'ragdoll';
      for (let i = 0; i < 60; i++) frame();
      const pose = c.animations.ragdoll_generated ?? c.animations['vr_pose_' + (ui ? 0 : v.vr_profile)];
      assert(pose, 'Generated pose must be present');
      const positions = Object.values(animations[pose].bones).flatMap(b => [b.position ?? []].flat().map(value));
      const bodyY = value(Object.entries(animations[pose].bones).find(([bone]) => bone.toLowerCase() === 'body')[1].position[1]);
      assert(positions.every(Number.isFinite));
      if (ui) assert.equal(queries, 0, 'No water reads in UI'); else assert(queries > 0, 'Compiled water branch must run');
      const beforeRelease = queries; name = ''; frame(); frame();
      assert.equal(queries, beforeRelease, 'Released ragdolls stop water queries');
      return { positions, queries, bodyY };
    }
    const dry = simulate(null), wet = simulate('water'), lava = simulate('lava'); simulate('lava', true);
    assert.notDeepEqual(wet.positions, dry.positions, 'Both compiler paths must apply buoyancy to their actual outputs');
    assert.notDeepEqual(lava.positions, wet.positions, 'Downloaded kernels must distinguish lava from water');
    if (path.endsWith('demo2.entity.json')) assert(wet.bodyY < 0 && lava.bodyY < 0, 'Verified iron-golem geometry must keep metal density in the downloaded patch');
    else assert(wet.bodyY > dry.bodyY && lava.bodyY > wet.bodyY, 'Ordinary models must receive stronger support in denser liquid');
  }
});
