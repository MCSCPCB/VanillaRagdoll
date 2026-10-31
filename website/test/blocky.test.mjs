import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { generate } from '../src/generator/index.mjs';
import { readUpload, languageTable } from '../src/generator/archive.mjs';
import { inspectPack } from '../src/generator/inspect.mjs';
import { blockyProgram, modeSettings, modeTextFiles, vanillaModeGate, installModes } from '../src/generator/blocky.mjs';
import { readFile } from 'node:fs/promises';
import { normalizeModel } from '../vendor/simple-ragdoll/src/core/model.mjs';
import { createProgram, testMath } from '../vendor/simple-ragdoll/src/core/program.mjs';
import { emit } from '../vendor/simple-ragdoll/src/core/expression.mjs';
import { pack, client, vanillaClient, geometry } from './fixtures.mjs';
import { script } from './molangeval.mjs';
import { vanillaCatalog } from '../src/generator/vanilla.mjs';
import { withVanillaResources } from '../src/generator/vanilla.mjs';
import { indexResources } from '../vendor/simple-ragdoll/src/resources.js';
import { apiSettings } from '../vendor/simple-ragdoll/src/core/api.mjs';
import { specializeApi } from '../vendor/simple-ragdoll/src/core/api-specialize.mjs';
import { terrainRecoveryProgram } from '../vendor/simple-ragdoll/src/core/terrain-recovery.mjs';
import { contactProgram } from '../src/generator/vanilla/contact-performance.mjs';
import { catTailOutput } from '../src/generator/vanilla/cat-native.mjs';
import { worldRig } from '../vendor/simple-ragdoll/src/core/space.mjs';
import { add, sub, rotate, multiply, modelRotation, conjugate, reflect, scale } from '../vendor/simple-ragdoll/src/core/math.mjs';

const math = { ...testMath, random: (a, b) => (a + b) / 2 };
const xyz = ['x', 'y', 'z'];

test('Ragdoll is unchanged and Blocky follows the jointless solver after its one-time breakup', async () => {
  const input = await readUpload(await pack(), 'demo.mcpack'), inspection = inspectPack(input.resourcePacks[0], new Map());
  const item = inspection.accepted[0], rig = normalizeModel(item.config, inspection.resources, item.record.value['minecraft:client_entity'].description);
  const original = createProgram(rig, { preview: true, terrainRecovery: false });
  const switched = blockyProgram(structuredClone(original), rig);
  const free = createProgram({ ...rig, joints: [], jointOrder: [] }, { preview: true, terrainRecovery: false });
  function actor(program, blocky) {
    const v = { vr_blocky: +blocky }, q = { is_alive: 1, is_baby: 0, is_name_any: () => 0, life_time: 1, delta_time: .05, model_scale: .0625, body_y_rotation: 0, frame_alpha: 1, death_ticks: 0,
      position: a => a === 1 ? 10 : 0, relative_block_has_any_tag: () => 0,
      bone_orientation_trs: n => ({ t: { x: 0, y: n === 'head' ? 20 : 12, z: 0 }, r: { x: 0, y: 0, z: 0 }, s: { x: 1, y: 1, z: 1 } }),
    };
    const run = nodes => new Function('v', 't', 'q', 'math', emit(nodes, 'js'));
    run(program.initialize)(v, {}, q, math);
    const steps = program.frameChunks.map(run), frame = () => { q.life_time += q.delta_time; for (const f of steps) f(v, {}, q, math); };
    frame(); frame(); q.is_alive = 0; frame();
    assert.equal(v.active, 1);
    v.b1vx = 3; // Give only the head a velocity, exposing any remaining constraint.
    const state = () => rig.bodies.flatMap((_, i) => [...xyz, ...xyz.map(k => 'v' + k), ...xyz.map(k => 'w' + k), 'qx', 'qy', 'qz', 'qw'].map(k => v[`b${i}${k}`]));
    return { v, frame, state };
  }
  const a = actor(original, false), b = actor(switched, false), c = actor(switched, true), d = actor(free, true);
  // Start the independent solver with the breakup velocities. Subsequent
  // frames must add neither joint constraints nor further breakup impulses.
  rig.bodies.forEach((_, i) => xyz.forEach(k => {
    for (const field of ['v', 'w']) d.v[`b${i}${field}${k}`] = c.v[`b${i}${field}${k}`];
  }));
  for (let i = 0; i < 40; i++) {
    for (const sim of [a, b, c, d]) sim.frame();
    assert.deepEqual(b.state(), a.state(), 'Ragdoll must keep the original arithmetic and trajectory');
    assert.deepEqual(c.state(), d.state(), 'Blocky must behave as a solver with no joints');
    assert(c.state().every(Number.isFinite));
  }
  assert(Math.abs(c.v.b1x - c.v.b0x) > 3, 'Detached head must move independently');
  assert(Math.abs(b.v.b1x - b.v.b0x) < 1, 'Ragdoll must retain its connection');
});

test('Blocky preserves the first pose and inherited momentum while seeding bounded, distinct tumbling once per activation', () => {
  const spec = vanillaCatalog.profiles.find(p => p.entity === 'minecraft:skeleton' && p.key === 'default');
  const resources = withVanillaResources(indexResources([]));
  const rig = normalizeModel({ ...spec.config, trigger: "!q.is_alive||q.is_name_any('ragdoll')", release: "q.is_alive&&!q.is_name_any('ragdoll')" }, resources, { geometry: spec.familyGeometry });
  const program = blockyProgram(createProgram(rig, { preview: true, terrainRecovery: false }), rig);
  const run = nodes => new Function('v', 't', 'q', 'math', emit(nodes, 'js'));
  const init = run(program.initialize), steps = program.frameChunks.map(run);
  const bones = new Map(vanillaCatalog.geometries[spec.geometry].bones.map(b => [b.name.toLowerCase(), b]));
  const poseKeys = [...xyz, 'qx', 'qy', 'qz', 'qw'];
  function actor(mode, units, velocity, named) {
    const v = { vr_blocky: mode }, position = [0, 20, 0]; let name = '', seed = 1234, randomCalls = 0;
    const random = (a, b) => { randomCalls++; seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return a + (b - a) * seed / 4294967296; };
    const math = { ...testMath, random };
    const q = { is_alive: 1, is_baby: 0, is_name_any: n => +(name === n), life_time: 1, delta_time: .05, model_scale: units / 16, body_y_rotation: 0, frame_alpha: 1, death_ticks: 0,
      position: i => position[i], relative_block_has_any_tag: () => 0,
      bone_orientation_trs: n => ({ t: Object.fromEntries(xyz.map((k, i) => [k, bones.get(n).pivot?.[i] ?? 0])), r: { x: 0, y: 0, z: 0 }, s: { x: 1, y: 1, z: 1 } }),
    };
    const frame = () => { q.life_time += q.delta_time; steps.forEach(f => f(v, {}, q, math)); };
    init(v, {}, q, math); frame(); frame();
    velocity.forEach((speed, i) => position[i] += speed * q.delta_time);
    if (named) name = 'ragdoll'; else q.is_alive = 0;
    frame(); assert.equal(v.active, 1);
    return { v, q, frame, randomCalls: () => randomCalls, name: value => { name = value; } };
  }
  for (const units of [.5, 1, 4]) for (const velocity of [[0, 0, 0], [4, 2, 0], [-4, 2, 0], [0, 0, 40]]) {
    const named = velocity.every(n => n === 0), a = actor(0, units, velocity, named), b = actor(1, units, velocity, named);
    const momentum = [0, 0, 0], spins = [];
    rig.bodies.forEach((_, i) => {
      for (const k of poseKeys) assert.equal(b.v[`b${i}${k}`], a.v[`b${i}${k}`], 'Breakup must not move or rotate the captured first pose');
      const mass = script('return ' + worldRig(rig).bodies[i].mass + ';')(b.v, {}, {}, math, {});
      const delta = xyz.map(k => b.v[`b${i}v${k}`] - a.v[`b${i}v${k}`]);
      const spin = xyz.map(k => b.v[`b${i}w${k}`] - a.v[`b${i}w${k}`]);
      delta.forEach((n, k) => momentum[k] += n * mass);
      assert(Math.hypot(...delta) <= .600001, 'Scattering must stay subordinate to inherited motion');
      assert(Math.hypot(...spin) > .001 && Math.hypot(...spin) <= 6.000001, 'Even quiet triggers must tumble, with bounded added angular speed');
      spins.push(spin);
    });
    assert(Math.hypot(...momentum) < 1e-7, 'Scattering must preserve total inherited linear momentum');
    assert(spins.some(s => Math.hypot(...sub(s, spins[0])) > .01), 'Pieces must not all spin together');
    const calls = b.randomCalls(), first = rig.bodies.map((_, i) => poseKeys.map(k => b.v[`b${i}${k}`]));
    for (let i = 0; i < 5; i++) b.frame();
    assert.equal(b.randomCalls(), calls, 'Tumbling must be initialized once, not applied each frame');
    assert(rig.bodies.some((_, i) => Math.abs(1 - Math.abs(first[i].slice(3).reduce((sum, q, k) => sum + q * b.v[`b${i}q${['x', 'y', 'z', 'w'][k]}`], 0))) > .0001), 'Parts must visibly rotate in free flight without terrain contacts');
    if (named) {
      b.name(''); b.frame(); assert.equal(b.v.active, 0);
      b.name('ragdoll'); b.frame(); assert.equal(b.v.active, 1);
      assert(b.randomCalls() > calls, 'Renaming back to ragdoll must initialize a new breakup');
    }
  }
});

test('downloaded patches select modes through an independent bilingual dropdown and keep one editable trigger policy', async () => {
  const nativeCore = family => {
    const spec = vanillaCatalog.profiles.find(p => p.entity === 'minecraft:' + family && p.key === 'default');
    const value = client('demo:' + family), c = value['minecraft:client_entity'].description;
    c.geometry = { default: spec.geometry }; c.scripts.scale = 1;
    c.scripts.animate = []; c.animations = {};
    return value;
  };
  // Native cores cover both combined and paged contact solvers in real patches.
  const result = await generate(await pack({ clients: [client(), vanillaClient(), nativeCore('ghast'), nativeCore('happy_ghast')] }), 'modes.mcpack');
  assert.equal(result.successful, 4, JSON.stringify(result.reports));
  const zip = await JSZip.loadAsync(result.download.data), manifest = JSON.parse(await zip.file('manifest.json').async('string'));
  assert.equal(manifest.format_version, 3);
  assert.equal(typeof manifest.header.version, 'string');
  assert.equal(manifest.header.min_engine_version, '1.26.50');
  assert.equal(manifest.subpacks, undefined);
  const [setting] = manifest.settings;
  assert.equal(setting.type, 'dropdown'); assert.equal(setting.default, 'ragdoll');
  assert.deepEqual(setting.options.map(o => o.name), ['ragdoll', 'blocky']);
  assert.notEqual(setting.name, 'vanilla_ragdoll:mode');
  for (const [lang, expected] of Object.entries({
    en_US: ['Mob Settings', 'Ragdoll §7Turns mobs into ragdolls.', 'Blocky §7Splits each mob in its individual parts.'],
    zh_CN: ['生物设置', '布娃娃 §7将生物变成布娃娃', '方块化 §7将每个生物拆分为独立部件'],
  })) {
    const text = languageTable(await zip.file(`texts/${lang}.lang`).async('string'));
    assert.deepEqual([setting.text, ...setting.options.map(o => o.text)].map(k => text.get(k)), expected);
  }
  const paths = Object.keys(zip.files).filter(p => !zip.files[p].dir), modePath = paths.find(p => /^animations\/.*_mode\.json$/.test(p));
  assert.equal(paths.filter(p => p.endsWith('_gate.json')).length, 1, 'Both modes use the same editable gate');
  assert(!paths.some(p => p.startsWith('subpacks/')));
  assert((await zip.file(modePath).async('uint8array')).length < 1024);
  const base = {};
  for (const p of paths.filter(p => p.startsWith('animations/'))) Object.assign(base, JSON.parse(await zip.file(p).async('string')).animations);
  for (const mode of [undefined, 'ragdoll', 'blocky']) for (const index of [0, 1, 2, 3]) {
    const animations = base;
    const c = JSON.parse(await zip.file(`entity/demo${index}.entity.json`).async('string'))['minecraft:client_entity'].description;
    const model = index ? vanillaCatalog.geometries[c.geometry.default] : geometry;
    const bones = new Map(model.bones.map(b => [b.name.toLowerCase(), b]));
    let name = '', reads = 0;
    const v = new Proxy({}, { get: (o, k) => k in o ? o[k] : 0 });
    const q = { is_alive: 1, is_baby: 0, is_in_ui: 0, life_time: 1, delta_time: 1 / 20, model_scale: .0625, body_y_rotation: 0, frame_alpha: 1, death_ticks: 0,
      is_pack_setting_selected: (id, option) => { assert.equal(id, setting.name); return +(option === (mode ?? setting.default)); },
      is_name_any: n => +(name === n), position: a => a === 1 ? 0 : .5,
      relative_block_has_any_tag: (_x, y, _z, ...tags) => { reads++; return +(y < 0 && !tags.includes('water') && !tags.includes('lava')); },
      bone_orientation_trs: n => { reads++; const b = bones.get(n); assert(b, n); return { t: Object.fromEntries(xyz.map((k, i) => [k, b.pivot?.[i] ?? 0])), r: { x: 0, y: 0, z: 0 }, s: { x: 1, y: 1, z: 1 } }; },
    };
    const run = s => script(s)(v, {}, q, math, {}), value = s => typeof s === 'number' ? s : run(s.includes(';') ? s : 'return ' + s + ';');
    c.scripts.initialize.forEach(run);
    const frame = () => {
      q.life_time += q.delta_time; c.scripts.pre_animation.forEach(run);
      for (const call of c.scripts.animate) for (const alias of typeof call === 'string' ? [call] : Object.keys(call)) {
        const source = animations[c.animations[alias]]?.anim_time_update; if (source) run(source);
      }
    };
    frame(); frame(); assert.equal(reads, 0, 'Live actors must not run physics');
    assert.equal(v.vr_blocky, +(mode === 'blocky'));
    name = 'ragdoll'; frame(); assert.equal(v.ragdoll_active, 1);
    for (let i = 0; i < 80; i++) frame();
    const output = animations[c.animations.ragdoll_generated ?? c.animations['vr_pose_' + v.vr_profile]].bones;
    assert(Object.values(output).flatMap(b => Object.values(b).flat()).map(value).every(Number.isFinite));
    name = ''; frame(); frame(); assert.equal(v.ragdoll_active, 0);
    q.is_alive = 0; frame(); assert.equal(v.ragdoll_active, 1, 'Death uses the selected mode too');
    q.is_in_ui = 1; frame(); assert.equal(v.ragdoll_active, 0);
    const saved = reads; frame(); assert.equal(reads, saved);
  }
});

test('maintained 1.2.0 pack uses the same settings, translations and query as generated patches', async () => {
  const manifest = JSON.parse(await readFile(new URL('../../src/manifest.json', import.meta.url), 'utf8'));
  assert.equal(manifest.format_version, 3); assert.equal(manifest.header.version, '1.2.0');
  assert.equal(manifest.header.min_engine_version, '1.26.50');
  assert(manifest.modules.every(m => m.version === '1.2.0')); assert.equal(manifest.subpacks, undefined);
  assert.deepEqual(manifest.settings, modeSettings(vanillaModeGate));
  for (const [path, text] of modeTextFiles(vanillaModeGate)) if (path.endsWith('.lang')) {
    const actual = languageTable(await readFile(new URL('../../src/' + path, import.meta.url), 'utf8'));
    for (const [key, value] of languageTable(text)) assert.equal(actual.get(key), value);
    assert(actual.get('pack.name').endsWith('1.2.0'));
  }
  const files = new Map(); installModes(files, vanillaModeGate);
  for (const [path, value] of files) assert.deepEqual(JSON.parse(await readFile(new URL('../../src/' + path, import.meta.url), 'utf8')), value);
});

for (const spread of [false, true]) test(spread ? 'separated native tentacles sleep and wake when remote support is removed' : 'a crowded native core cannot starve detached tentacles of terrain contacts', () => {
  const spec = vanillaCatalog.profiles.find(p => p.entity === 'minecraft:ghast');
  const resources = withVanillaResources(indexResources([]));
  const rig = normalizeModel({ ...spec.config, trigger: '!q.is_alive', release: 'q.is_alive' }, resources, { geometry: spec.familyGeometry });
  let raw = createProgram({ ...rig, api: apiSettings() }, { preview: true, terrainRecovery: false });
  raw = contactProgram(raw, rig, { id: spec.entity }, { geometry: spec.alias });
  terrainRecoveryProgram(raw, rig);
  const program = blockyProgram(specializeApi(raw, rig.api), rig, { terrainShapeIndices: rig.shapes.flatMap((s, i) => rig.bodies[s.body].bone === 'body' ? [i] : []) });
  const model = vanillaCatalog.geometries[spec.geometry], bones = new Map(model.bones.map(b => [b.name.toLowerCase(), b]));
  let removed = false, remoteReads = 0;
  const v = { vr_blocky: 1 }, q = { is_alive: 1, is_baby: 0, life_time: 1, delta_time: .05, model_scale: .0625, body_y_rotation: 0, frame_alpha: 1, death_ticks: 0,
    position: a => a === 1 ? 0 : .5,
    relative_block_has_any_tag: (x, y, _z, ...tags) => { if (x > 5) remoteReads++; return +(y < -6 && !(removed && x > 5) && !tags.includes('water') && !tags.includes('lava')); },
    bone_orientation_trs: n => ({ t: Object.fromEntries(xyz.map((k, i) => [k, bones.get(n).pivot?.[i] ?? 0])), r: { x: 0, y: 0, z: 0 }, s: { x: 1, y: 1, z: 1 } }),
  };
  const run = nodes => new Function('v', 't', 'q', 'math', emit(nodes, 'js'));
  run(program.initialize)(v, {}, q, math);
  const steps = program.frameChunks.map(run), frame = () => { q.life_time += q.delta_time; for (const f of steps) f(v, {}, q, math); };
  frame(); frame(); q.is_alive = 0; frame();
  // Test both a crowded core with one remote part and separate landing places.
  // The latter exercises sleeping scans without requiring a pile to settle.
  for (let i = 1; i < rig.bodies.length; i++) {
    if (!spread && i > 1) continue;
    const angle = (i - 1) * 2 * Math.PI / (rig.bodies.length - 1);
    v[`b${i}x`] += 8 * Math.cos(angle);
    v[`b${i}z`] += 8 * Math.sin(angle);
  }
  for (let i = 0; i < 240; i++) frame();
  assert(v.oy + v.b1y > -6.5, `Detached tentacle must not fall through the floor: ${v.oy + v.b1y}`);
  assert.equal(v.recovery_blocked, 0, 'Ordinary landings must settle without invoking the stuck-body safeguard');
  assert(v.oy + v.b0y > -4.5, 'The large core must also remain above ground');
  for (let i = 1; i < rig.bodies.length; i++) assert(v.oy + v[`b${i}y`] > -6.5, 'Every tentacle must stay above the floor');
  if (!spread) return;
  assert(v.sleep >= 10, 'Separated parts must reach ordinary sleep');
  const y = v.b1y, coreY = v.b0y; remoteReads = 0;
  for (let i = 0; i < 20; i++) frame();
  assert.equal(v.b1y, y); assert(remoteReads > 0, 'Sleeping scan must include the remote tentacle');
  removed = true;
  for (let i = 0; i < 30; i++) frame();
  assert(v.b1y < y - 1, 'Removing remote support must wake and drop the detached tentacle');
  assert(Math.abs(v.b0y - coreY) < .1, `The supported core must stay on the floor: ${coreY} -> ${v.b0y}`);
});

test('Blocky cat tail preserves its native first pose and then follows independent pivot motion', () => {
  const spec = vanillaCatalog.profiles.find(p => p.entity === 'minecraft:cat' && p.key === 'default');
  const rig = normalizeModel(spec.config, withVanillaResources(indexResources([])), { geometry: spec.familyGeometry });
  const i = rig.bodies.findIndex(b => b.bone === 'tail2'), parent = rig.bodies[i].parent;
  const program = { initialize: [], frameChunks: [[], []] }, local = 'v.test_local_';
  catTailOutput(program, rig, { index: i, local });
  const run = nodes => new Function('v', 't', 'q', 'math', emit(nodes, 'js'));
  const init = run(program.initialize), activate = run(program.frameChunks[0]), output = run(program.frameChunks[1]);
  for (const mode of [0, 1]) for (const yaw of [0, 75, -110]) {
    const v = { vr_blocky: mode, active: 1, activated: 1, body_to_world: .05 }, origin = [1, -8, 2], shift = [.2, -.3, .5];
    init(v, {}, {}, math);
    for (const [k, axis] of xyz.entries()) { v['test_local_p' + axis] = shift[k]; v['test_local_r' + axis] = [45, -12, 6][k]; }
    const basis = modelRotation([90, 15, -10]), localQ = modelRotation([45, -12, 6]);
    function pose(index, pivot, q) {
      const physical = multiply(modelRotation([0, -yaw, 0]), [-q[0], -q[1], q[2], q[3]]);
      const world = rotate(modelRotation([0, -yaw, 0]), scale(reflect(add(pivot, rotate(q, sub(rig.bodies[index].modelCenter, rig.bodies[index].pivot)))), v.body_to_world));
      xyz.forEach((k, a) => { v[`render${index}${k}`] = world[a]; });
      [...xyz, 'w'].forEach((k, a) => { v[`render${index}q${k}`] = physical[a]; v[`pose${index}q${k}`] = q[a]; });
    }
    let parentQ = modelRotation([38, 22, -8]), parentPivot = [0, 9, 8];
    const childPivot = add(parentPivot, rotate(parentQ, add(origin, shift))), childQ = multiply(parentQ, multiply(basis, localQ));
    pose(parent, parentPivot, parentQ); pose(i, childPivot, childQ);
    activate(v, {}, {}, math); output(v, {}, {}, math);
    const position = () => xyz.map(k => v[`out${i}p${k}`]);
    assert(Math.hypot(...sub(position(), shift)) < 1e-8, 'First frame must match the live local position');
    v.activated = 0;
    parentQ = modelRotation([100, -40, 35]); parentPivot = [3, -2, 4];
    const movedPivot = add(childPivot, [15, 4, -9]), movedQ = modelRotation([-20, 68, 31]);
    pose(parent, parentPivot, parentQ); pose(i, movedPivot, movedQ); output(v, {}, {}, math);
    const drawn = add(parentPivot, rotate(parentQ, add(origin, position())));
    if (mode) assert(Math.hypot(...sub(drawn, movedPivot)) < 1e-8, 'Blocky output must follow its independent physical pivot');
    else assert.deepEqual(position(), shift, 'Ragdoll keeps its verified native attachment');
    const rotation = modelRotation(xyz.map(k => v[`out${i}r${k}`])), drawnQ = multiply(parentQ, multiply(basis, rotation));
    assert(Math.abs(1 - Math.abs(multiply(conjugate(drawnQ), movedQ)[3])) < 1e-8);
  }
});
