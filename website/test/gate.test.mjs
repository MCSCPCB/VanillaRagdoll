import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { generate } from '../src/generator/index.mjs';
import { pack, client, vanillaClient } from './fixtures.mjs';
import { script } from './molangeval.mjs';
import { testMath } from '../vendor/simple-ragdoll/src/core/program.mjs';
import { validateMolang } from '../src/generator/program-validation.mjs';

test('one editable policy controls custom and native mobs in the same frame, independently per patch', async () => {
  const upload = await pack({ clients: [client(), vanillaClient()] });
  const result = await generate(upload, 'demo.mcpack');
  assert.equal(result.successful, 2, JSON.stringify(result.reports));
  const zip = await JSZip.loadAsync(result.download.data), animations = {}, clients = [];
  const gates = Object.keys(zip.files).filter(n => /animations\/.*_gate\.json$/.test(n));
  assert.equal(gates.length, 1);
  for (const f of Object.values(zip.files)) if (!f.dir) {
    if (f.name.startsWith('animations/')) Object.assign(animations, JSON.parse(await f.async('string')).animations);
    if (f.name.startsWith('entity/')) clients.push(JSON.parse(await f.async('string'))['minecraft:client_entity'].description);
  }
  const gate = Object.keys(JSON.parse(await zip.file(gates[0]).async('string')).animations)[0];
  const defaultPolicy = animations[gate].anim_time_update;
  validateMolang(defaultPolicy);
  for (const c of clients) {
    assert.equal(c.animations[Object.keys(c.scripts.animate[0])[0]], gate);
    assert(!JSON.stringify(c).includes('is_name_any'), 'Policy must not remain embedded in clients');
  }
  for (const [id, a] of Object.entries(animations)) if (id !== gate) assert(!JSON.stringify(a).includes('is_name_any'));

  function actor(c) {
    let name = '', reads = 0;
    const v = new Proxy({}, { get: (o, k) => k in o ? o[k] : 0 });
    const q = { is_alive: 1, is_baby: 0, is_in_ui: 0, life_time: 0, delta_time: 1 / 60, death_ticks: 0, body_y_rotation: 0, frame_alpha: 1, model_scale: .0625,
      is_name_any: expected => +(name === expected), position: a => a === 1 ? 10 : 0,
      bone_orientation_trs: () => { reads++; return { t: { x: 0, y: 12, z: 0 }, r: { x: 0, y: 30, z: 0 }, s: { x: 1, y: 1, z: 1 } }; },
      block_has_any_tag: () => 0, relative_block_has_any_tag: () => 0,
    };
    const math = { ...testMath, random: (a, b) => (a + b) / 2 }, run = s => script(s)(v, {}, q, math, {});
    c.scripts.initialize.forEach(run);
    const frame = () => {
      q.life_time += q.delta_time; c.scripts.pre_animation.forEach(run);
      for (const call of c.scripts.animate) for (const alias of typeof call === 'string' ? [call] : Object.keys(call)) {
        // Eager evaluation also checks that policy cannot override UI safety.
        const code = animations[c.animations[alias]]?.anim_time_update;
        if (code) run(code);
      }
      return +v.ragdoll_active;
    };
    frame(); frame();
    return { frame, q, v, name: n => { name = n; }, reads: () => reads };
  }
  const actors = clients.map(actor);
  const all = expected => actors.forEach(a => assert.equal(a.frame(), expected));
  all(0);
  actors.forEach(a => a.name('ragdoll')); all(1);
  actors.forEach(a => a.name('')); all(0); all(0);
  actors.forEach(a => { a.q.is_alive = 0; }); all(1);
  // Edit only the shared gate. Disable even existing death simulations.
  animations[gate].anim_time_update = 'v.vr_trigger=0;v.vr_release=1;return 0;';
  all(0); all(0);
  // A new name-only policy disables ordinary death and changes both entry/release.
  animations[gate].anim_time_update = "v.vr_trigger=q.is_name_any('test');v.vr_release=!q.is_name_any('test');return 0;";
  actors.forEach(a => a.name('ragdoll')); all(0);
  actors.forEach(a => a.name('test')); all(1);
  actors.forEach(a => a.name('')); all(0);
  animations[gate].anim_time_update = 'v.vr_trigger=1;v.vr_release=0;return 0;';
  actors.forEach(a => { a.q.is_in_ui = 1; });
  const reads = actors.map(a => a.reads()); all(0); all(0);
  assert.deepEqual(actors.map(a => a.reads()), reads);

  const second = await generate(await pack({ uuid: 'aaaaaaaa-1111-4111-a111-111111111111' }), 'second.mcpack');
  const secondZip = await JSZip.loadAsync(second.download.data);
  const otherPath = Object.keys(secondZip.files).find(n => /animations\/.*_gate\.json$/.test(n));
  const other = JSON.parse(await secondZip.file(otherPath).async('string')).animations;
  assert.notEqual(otherPath, gates[0]); assert(!Object.hasOwn(other, gate));
  assert.equal(Object.values(other)[0].anim_time_update, defaultPolicy);
});
