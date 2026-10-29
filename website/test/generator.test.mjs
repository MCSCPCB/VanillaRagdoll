import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { readUpload, englishName, InputError } from '../src/generator/archive.mjs';
import { geometryBranches, checkGeometry } from '../src/generator/inspect.mjs';
import { inspectPack, behaviorIndex } from '../src/generator/inspect.mjs';
import { readFile } from 'node:fs/promises';
import { generate, patchUUID } from '../src/generator/index.mjs';
import { pack, client, geometry, manifest, rpUUID, bpUUID } from './fixtures.mjs';

test('English localization resolves language keys and has readable fallbacks', () => {
  const b = s => new TextEncoder().encode(s);
  assert.equal(englishName(manifest(), new Map([['texts/en_US.lang', b('pack.name=§aCreatures ## comment')]]), 'upload'), 'Creatures');
  assert.equal(englishName(manifest(), new Map([['texts/en_GB.lang', b('pack.name=British title')]]), 'upload'), 'British title');
  assert.equal(englishName(manifest(), new Map(), 'upload'), 'upload');
  assert.equal(englishName(manifest('resources', 'Literal title'), new Map(), 'upload'), 'Literal title');
});

test('folder addon and nested mcaddon preserve RP/BP boundaries', async () => {
  const rp = await pack(), bp = new JSZip(); bp.file('manifest.json', JSON.stringify(manifest('data', 'Behavior', bpUUID)));
  const nested = new JSZip(); nested.file('demo.mcpack', rp); nested.file('bp.mcpack', await bp.generateAsync({ type: 'uint8array' }));
  const result = await readUpload(await nested.generateAsync({ type: 'uint8array' }), 'demo.mcaddon');
  assert.equal(result.resourcePacks.length, 1); assert.equal(result.behaviorPacks.length, 1);
  const folders = new JSZip(), inner = await JSZip.loadAsync(rp);
  for (const [path, f] of Object.entries(inner.files)) if (!f.dir) folders.file('Addon/RP/' + path, await f.async('uint8array'));
  folders.file('Addon/BP/manifest.json', JSON.stringify(manifest('data', 'Behavior', bpUUID)));
  assert.equal((await readUpload(await folders.generateAsync({ type: 'uint8array' }), 'folder.zip')).resourcePacks[0].name, 'Test Creatures');
});

test('unsafe archives and cyclic bones are rejected before traversal', async () => {
  const zip = new JSZip(); zip.file('../escape.txt', 'bad');
  await assert.rejects(readUpload(await zip.generateAsync({ type: 'uint8array' }), 'bad.zip'), InputError);
  const g = structuredClone(geometry); g.bones[0].parent = 'head';
  assert.throws(() => checkGeometry(g), /循环/);
  const c = await generate(await pack({ model: g }), 'cycle.mcpack');
  assert.equal(c.download, null); assert.equal(c.successful, 0); assert.match(c.reports[0].skipped[0].reason, /循环/);
});

test('explicit model selectors are parsed; ambiguous arrays are not guessed', () => {
  const branches = geometryBranches('query.is_baby ? Geometry.baby : Geometry.default');
  assert.deepEqual(branches.map(b => b.alias), ['baby', 'default']);
  assert.throws(() => geometryBranches('Array.models[q.variant]'), /确定/);
});

test('patch contains only required overrides; source, normal state and identity are preserved', async () => {
  const original = await pack({ clients: [client(), client('demo:second')] }), copy = original.slice();
  const result = await generate(original, 'demo.mcpack');
  assert.equal(result.successful, 2, JSON.stringify(result.reports)); assert.equal(result.skipped, 0);
  assert.equal(result.download.name, 'Test Creatures Ragdoll.mcpack'); assert.deepEqual(original, copy);
  const zip = await JSZip.loadAsync(result.download.data), names = Object.keys(zip.files).filter(n => !zip.files[n].dir);
  assert(names.every(n => n === 'manifest.json' || /^(entity|animations)\//.test(n)));
  const m = JSON.parse(await zip.file('manifest.json').async('string'));
  assert.equal(m.header.name, 'Test Creatures Ragdoll'); assert.equal(m.header.description, 'Simple Ragdoll');
  assert.notEqual(m.header.uuid, rpUUID); assert.equal(m.header.uuid, await patchUUID(rpUUID, 'header'));
  assert.deepEqual(m.dependencies, [{ uuid: rpUUID, version: [2, 3, 4] }]);
  const c = JSON.parse(await zip.file('entity/demo0.entity.json').async('string'))['minecraft:client_entity'].description;
  const old = client()['minecraft:client_entity'].description;
  for (const k of ['identifier', 'geometry', 'textures', 'materials', 'render_controllers']) assert.deepEqual(c[k], old[k]);
  assert.equal(c.scripts.scale, old.scripts.scale); assert.equal(c.scripts.initialize[0], old.scripts.initialize[0]);
  assert.equal(c.scripts.pre_animation[0], old.scripts.pre_animation[0]); assert.equal(c.animations.idle, old.animations.idle);
  assert(c.scripts.animate.some(a => a.idle === '!v.ragdoll_active')); assert(!c.animations.ragdoll_input);
  assert(c.scripts.pre_animation.some(s => s.includes('v.vr_motion_pending')));
  const definitions = new Set();
  for (const path of names.filter(n => n.startsWith('animations/'))) for (const id of Object.keys(JSON.parse(await zip.file(path).async('string')).animations)) { assert(!definitions.has(id)); definitions.add(id); }
  for (const [alias, id] of Object.entries(c.animations)) if (alias.startsWith('ragdoll_')) assert(definitions.has(id), id);
});

test('multiple independent RPs download as distinct patches in one ZIP', async () => {
  const zip = new JSZip(); zip.file('first.mcpack', await pack()); zip.file('second.mcpack', await pack({ name: 'Another Pack', uuid: 'aaaaaaaa-1111-4111-a111-111111111111' }));
  const result = await generate(await zip.generateAsync({ type: 'uint8array' }), 'collection.zip');
  assert.equal(result.successful, 2); assert.equal(result.download.name, 'collection Ragdoll.zip');
  assert.deepEqual(Object.keys((await JSZip.loadAsync(result.download.data)).files).sort(), ['Another Pack Ragdoll.mcpack', 'Test Creatures Ragdoll.mcpack']);
});

test('one unsupported entity leaves the valid entity intact and gives no empty patch', async () => {
  const bad = client('demo:missing'); bad['minecraft:client_entity'].description.geometry.default = 'geometry.absent';
  const result = await generate(await pack({ clients: [client(), bad] }), 'mixed.mcpack');
  assert.equal(result.successful, 1); assert.equal(result.skipped, 1);
  const zip = await JSZip.loadAsync(result.download.data); assert(!zip.file('entity/demo1.entity.json'));
});

test('valid pack icon is copied byte for byte; malformed manifest is isolated from other packs', async () => {
  const icon = new Uint8Array(await readFile(new URL('../public/pack_icon.png', import.meta.url)));
  const upload = new JSZip(); upload.file('valid.mcpack', await pack({ extra: { 'pack_icon.png': icon } }));
  upload.file('bad/manifest.json', JSON.stringify({ header: {}, modules: 123 }));
  const result = await generate(await upload.generateAsync({ type: 'uint8array' }), 'bundle.zip');
  assert.equal(result.successful, 1); assert.equal(result.warnings.length, 1);
  const zip = await JSZip.loadAsync(result.download.data); assert.deepEqual(await zip.file('pack_icon.png').async('uint8array'), icon);
});

test('ambiguous definitions exclude only their consumers; complex live expressions remain untouched', async () => {
  const bad = client('demo:ambiguous'); bad['minecraft:client_entity'].description.geometry.default = 'geometry.conflict';
  const complex = client('demo:complex'); complex['minecraft:client_entity'].description.scripts.animate = [{ idle: 'return q.is_alive;' }];
  const extra = {
    'models/entity/a.json': { 'minecraft:geometry': [{ ...geometry, description: { identifier: 'geometry.conflict' } }] },
    'models/entity/b.json': { 'minecraft:geometry': [{ ...geometry, description: { identifier: 'geometry.conflict' }, bones: [{ name: 'other', cubes: [{ origin: [0,0,0], size: [1,1,1] }] }] }] },
  };
  const upload = await readUpload(await pack({ clients: [client(), bad, complex], extra }), 'mixed.zip');
  const inspection = inspectPack(upload.resourcePacks[0], new Map());
  assert.deepEqual(inspection.accepted.map(e => e.id), ['demo:mob']);
  assert.match(inspection.skipped[0].reason, /歧义/); assert.match(inspection.skipped[1].reason, /复杂动画/);
});

test('explicit same-skeleton variants generate while mismatched skeletons are skipped', async () => {
  const c = client(), d = c['minecraft:client_entity'].description;
  d.geometry.baby = 'geometry.baby'; d.render_controllers = ['controller.render.demo'];
  const baby = structuredClone(geometry); baby.description.identifier = 'geometry.baby'; baby.bones[0].cubes[0].size = [6,8,4];
  const extra = { 'render_controllers/demo.json': { render_controllers: { 'controller.render.demo': { geometry: 'q.is_baby?Geometry.baby:Geometry.default' } } }, 'models/entity/baby.json': { 'minecraft:geometry': [baby] } };
  const result = await generate(await pack({ clients: [c], extra }), 'variants.zip');
  assert.equal(result.successful, 1, JSON.stringify(result.reports));
  baby.bones[1].name = 'different';
  const upload = await readUpload(await pack({ clients: [c], extra }), 'variants.zip');
  assert.match(inspectPack(upload.resourcePacks[0], new Map()).skipped[0].reason, /骨骼结构不一致/);
});

test('provided BP excludes nonliving helpers, and no API flags survive auto configuration', async () => {
  const rp = (await readUpload(await pack(), 'demo.zip')).resourcePacks[0];
  const bp = { files: new Map([['entities/mob.json', new TextEncoder().encode(JSON.stringify({ 'minecraft:entity': { description: { identifier: 'demo:mob' }, components: { 'minecraft:projectile': {} } } }))]]) };
  const out = inspectPack(rp, behaviorIndex([bp])); assert.equal(out.accepted.length, 0); assert.match(out.skipped[0].reason, /生命值/);
  const accepted = inspectPack(rp, new Map()).accepted;
  assert(Object.values(accepted[0].config.api).every(v => v === false));
});
