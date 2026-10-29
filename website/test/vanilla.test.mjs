import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { generate } from '../src/generator/index.mjs';
import { inspectPack } from '../src/generator/inspect.mjs';
import { readUpload } from '../src/generator/archive.mjs';
import { vanillaCatalog } from '../src/generator/vanilla.mjs';
import { testMath } from '../vendor/simple-ragdoll/src/core/program.mjs';
import { pack, vanillaClient, geometry } from './fixtures.mjs';
import { script } from './molangeval.mjs';

async function inspect(options) { return inspectPack((await readUpload(await pack(options), 'native.mcpack')).resourcePacks[0], new Map()); }

test('vanilla geometry reuses maintained configurations; upload overrides and mixed models keep their own rig', async () => {
  const witch = vanillaClient('witch');
  const result = await inspect({ clients: [witch, vanillaClient()] });
  assert.equal(result.accepted.length, 2); assert.equal(result.skipped.length, 0);
  const profile = result.accepted[0].profiles[0], template = vanillaCatalog.profiles.find(p => p.entity === 'minecraft:witch');
  assert.deepEqual(profile.config.bodies, template.config.bodies);
  assert.deepEqual(profile.config.joints, template.config.joints);
  assert.deepEqual(profile.config.collisionPairs, template.config.collisionPairs);
  assert(Object.values(profile.config.api).every(v => !v));
  assert.equal(result.accepted[1].profiles[0].native.alias, 'baby');

  const override = structuredClone(geometry); override.description.identifier = witch['minecraft:client_entity'].description.geometry.default;
  const custom = await inspect({ clients: [witch], model: override });
  assert.equal(custom.accepted.length, 1); assert(!custom.accepted[0].profiles);
  assert.deepEqual(Object.keys(custom.accepted[0].config.bodies).sort(), ['body', 'head']);

  const mixed = vanillaClient(); mixed['minecraft:client_entity'].description.geometry.default = 'geometry.demo';
  const m = await inspect({ clients: [mixed] });
  assert.equal(m.accepted[0].profiles.length, 2); assert(m.accepted[0].profiles[0].native); assert(!m.accepted[0].profiles[1].native);
  mixed['minecraft:client_entity'].description.scripts.animate.push('unused_big_head');
  const compiledMixed = await generate(await pack({ clients: [mixed] }), 'mixed.zip');
  assert.equal(compiledMixed.successful, 1, JSON.stringify(compiledMixed.reports));
  const unsupported = vanillaClient('witch'); unsupported['minecraft:client_entity'].description.geometry.default = 'geometry.slime';
  assert.match((await inspect({ clients: [unsupported] })).skipped[0].reason, /专用原生渲染/);
  for (const family of ['spider', 'guardian']) {
    const mob = vanillaClient('witch'); mob['minecraft:client_entity'].description.geometry.default = `geometry.${family}.v1.8`;
    const shared = await inspect({ clients: [mob] });
    assert.equal(shared.accepted[0].profiles[0].native.entity, 'minecraft:' + family, 'Shared geometry defaults to its ordinary family, not a cave/elder variant');
  }
});

test('native patch preserves addon live behavior and textures, adds no models, and freezes illager visibility only while active', async () => {
  const clients = [vanillaClient(), vanillaClient('witch'), vanillaClient('evoker')];
  // A real witch-style legacy controller stack, with decorative nose animation.
  const witch = clients[1]['minecraft:client_entity'].description;
  delete witch.scripts.animate;
  witch.animations = { general: 'animation.witch.general', villager_general: 'animation.villager.general', look_at_target: 'animation.common.look_at_target', move: 'animation.villager.move' };
  witch.animation_controllers = [{ general: 'controller.animation.witch.general' }, { move: 'controller.animation.villager.move' }];
  const result = await generate(await pack({ clients }), 'native.zip');
  assert.equal(result.successful, 3, JSON.stringify(result.reports)); assert.equal(result.skipped, 0);
  const zip = await JSZip.loadAsync(result.download.data), names = Object.keys(zip.files);
  assert(!names.some(p => /^(models|textures)\//.test(p)));
  for (const [i, original] of clients.entries()) {
    const before = original['minecraft:client_entity'].description;
    const after = JSON.parse(await zip.file(`entity/demo${i}.entity.json`).async('string'))['minecraft:client_entity'].description;
    for (const k of ['identifier', 'geometry', 'textures', 'materials']) assert.deepEqual(after[k], before[k]);
    assert.equal(after.scripts.scale, before.scripts.scale);
    assert.equal(after.scripts.initialize[0], before.scripts.initialize[0]);
    assert.equal(after.scripts.pre_animation[0], before.scripts.pre_animation[0]);
    if (before.scripts.animate) {
      assert(after.scripts.animate.some(c => c.idle === '!v.ragdoll_active'));
      assert(!after.scripts.animate.some(c => JSON.stringify(c).includes('unused_legacy')));
      assert(!JSON.stringify(after.scripts.pre_animation).includes('vr_head_scale='), 'Do not activate unused baby head animation');
    }
    assert(!after.animation_controllers);
  }
  assert(names.some(p => /_capture.json$/.test(p))); assert(names.some(p => /_decorations.json$/.test(p)));
  const file = names.find(p => p.startsWith('render_controllers/') && p.endsWith('.json'));
  const rc = Object.values(JSON.parse(await zip.file(file).async('string')).render_controllers)[0];
  assert.deepEqual(rc.textures, vanillaCatalog.renderers['controller.render.evoker'].textures);
  assert(rc.part_visibility.slice(-3).every(p => Object.values(p)[0].startsWith('v.ragdoll_active?')));
});

test('baby native geometry captures live local pose, retains head yaw, switches profiles and releases on rename', async () => {
  const input = vanillaClient(), result = await generate(await pack({ clients: [input] }), 'native.zip');
  assert.equal(result.successful, 1, JSON.stringify(result.reports));
  const zip = await JSZip.loadAsync(result.download.data);
  const c = JSON.parse(await zip.file('entity/demo0.entity.json').async('string'))['minecraft:client_entity'].description;
  const animations = {};
  for (const f of Object.values(zip.files)) if (f.name.startsWith('animations/') && !f.dir) Object.assign(animations, JSON.parse(await f.async('string')).animations);
  const math = { ...testMath, random: (a, b) => (a + b) / 2 };
  const bones = vanillaCatalog.geometries['geometry.zombie.baby'].bones;
  let name = '', nativeReads = 0;
  const v = {}, q = { is_in_ui: 0, is_alive: 1, is_baby: 1, life_time: 0, delta_time: 1/60, death_ticks: 0, body_y_rotation: 0, frame_alpha: 1, model_scale: .03125,
    is_name_any: n => +(name === n), position: a => a === 1 ? 10 : 0, relative_block_has_any_tag: () => 0, block_has_any_tag: () => 0,
    bone_orientation_trs: bone => { nativeReads++; return { t: { x: 0, y: 12, z: 0 }, r: { x: 0, y: 0, z: 0 }, s: { x: 1, y: 1, z: 1 } }; },
  };
  const run = s => script(s)(v, {}, q, math, {}), expr = s => typeof s === 'number' ? s : run(s.includes(';') ? s : 'return ' + s + ';');
  c.scripts.initialize.forEach(run);
  function frame() {
    q.life_time += q.delta_time; c.scripts.pre_animation.forEach(run);
    const channels = Object.fromEntries(bones.map(b => [b.name.toLowerCase(), { position: [0,0,0], rotation: b.rotation ?? [0,0,0], scale: [1,1,1] }]));
    for (const call of c.scripts.animate) for (const [alias, weight] of typeof call === 'string' ? [[call,1]] : Object.entries(call)) {
      const active = expr(weight), a = animations[c.animations[alias]];
      if (a?.anim_time_update) { run(a.anim_time_update); continue; } // Also check internal kernel guards.
      if (!active) continue;
      if (alias === 'idle') { channels.head.rotation[1] += 30; continue; }
      if (!a) continue;
      for (const [bone, values] of Object.entries(a.bones)) for (const ch of ['position', 'rotation', 'scale']) if (values[ch] !== undefined) {
        const output = channels[bone.toLowerCase()]?.[ch]; if (!output) continue;
        const values3 = Array.isArray(values[ch]) ? values[ch] : [values[ch], values[ch], values[ch]];
        for (let axis = 0; axis < 3; axis++) {
          v.test_this = output[axis]; const n = expr(values3[axis]); assert(Number.isFinite(n), `${alias} ${bone} ${ch}`);
          output[axis] = ch === 'scale' ? output[axis] * n : output[axis] + n;
        }
      }
    }
    return channels;
  }
  for (let i=0;i<10;i++) frame();
  assert.equal(nativeReads, 0); assert.equal(v.ragdoll_active, 0); assert.equal(v.vr_profile, 0);
  name = 'ragdoll'; const first = frame(); assert.equal(v.ragdoll_active, 1);
  assert.equal(nativeReads, 0, 'Baby uses local capture, never the wrong native skeleton');
  assert(Math.abs(first.head.rotation[1] - 30) < 1e-5, 'Last live head yaw must survive activation');
  for (let i=0;i<20;i++) frame();
  name = ''; frame(); frame(); assert.equal(v.ragdoll_active, 0); assert.equal(v.vr_run, 0);
  q.is_baby = 0; frame(); assert.equal(v.vr_profile, 1);
  name = 'ragdoll'; frame(); assert.equal(v.ragdoll_active, 1); assert.equal(nativeReads, 6);
  q.is_in_ui = 1; frame(); assert.equal(v.ragdoll_active, 0); assert.equal(nativeReads, 6);
});
