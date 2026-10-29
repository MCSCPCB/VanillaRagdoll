import test from 'node:test';
import assert from 'node:assert/strict';
import { materialRig, materialProgram, bodyMaterial, materials } from '../src/generator/materials.mjs';
import { waterStep, waterLayout } from '../src/generator/water-buoyancy.mjs';
import { worldRig } from '../vendor/simple-ragdoll/src/core/space.mjs';
import { emit } from '../vendor/simple-ragdoll/src/core/expression.mjs';
import { createProgram, testMath } from '../vendor/simple-ragdoll/src/core/program.mjs';
import { normalizeModel } from '../vendor/simple-ragdoll/src/core/model.mjs';
import { specializeApi } from '../vendor/simple-ragdoll/src/core/api-specialize.mjs';
import { apiSettings, BP_API_METHODS } from '../vendor/simple-ragdoll/src/core/api.mjs';
import { waterProgram } from '../src/generator/water-buoyancy.mjs';
import { script } from './molangeval.mjs';

function fixture(entity, bone = 'body', massFromDensity = 1) {
  const shape = { body: 0, part: 0, center: [0, 0, 0], half: [8, 4, 4], quaternion: [0, 0, 0, 1] };
  const body = { bone, mass: 10, inverseMass: .1, inverseInertia: [.01, .01, .01], massFromDensity, friction: .3, restitution: 1, shapes: [shape] };
  const original = { bodies: [body], shapes: [shape], joints: [], variants: [{ bodies: [body] }], simulation: { frequency: 20, sleep: { seconds: 1, checkInterval: .5 } } };
  const rig = materialRig(original, entity), run = script(emit(waterStep(rig)));
  return { original, rig, run };
}

function step(run, fluid, units = 1) {
  const v = { body_units: units, body_units2: units ** 2, body_units3: units ** 3, tick: 1, sleep: 0,
    gravity_x: 0, gravity_y: -9.81, gravity_z: 0, ox: 0, oy: 0, oz: 0, ex: 0, ey: 0, ez: 0,
    b0x: 0, b0y: 0, b0z: 0, b0qx: 0, b0qy: 0, b0qz: 0, b0qw: 1,
    b0vx: 1, b0vy: 0, b0vz: 0, b0wx: 0, b0wy: 1, b0wz: 0 };
  let queries = 0;
  const q = { relative_block_has_any_tag: (x, y, z, ...tags) => { queries++; return +tags.includes(fluid(x, y, z)); } };
  run(v, {}, q, testMath, {});
  return { ...v, queries, netVy: v.b0vy - 9.81 / 20 };
}

test('actual fluid code sinks metals, floats light materials, and distinguishes water/lava for dense fictional bodies', () => {
  for (const entity of ['iron_golem', 'copper_golem', 'creaking', 'snow_golem', 'skeleton', 'slime', 'magma_cube', 'sulfur_cube', 'blaze', 'breeze', 'villager_v2']) {
    const { run } = fixture('minecraft:' + entity), water = step(run, () => 'water'), lava = step(run, () => 'lava');
    assert.equal(step(run, () => null).queries, 2, 'No extra block queries on dry land');
    assert.equal(water.queries, 4); assert.equal(lava.queries, 4);
    assert(lava.b0vy > water.b0vy, entity + ': denser lava gives more buoyancy');
    assert(lava.b0vx < water.b0vx && lava.b0wy < water.b0wy, entity + ': lava has stronger drag');
    if (['iron_golem', 'copper_golem'].includes(entity)) assert(lava.netVy < 0 && water.netVy < 0, entity + ': must sink in both');
    else if (['creaking', 'snow_golem', 'breeze', 'villager_v2'].includes(entity)) assert(water.netVy > 0, entity + ': must float');
    else assert(water.netVy < 0 && lava.netVy > 0, entity + ': water and lava must differ');
  }
});

test('two liquid points accumulate independent torque and density, with density invariant across baby/adult scales', () => {
  for (const massMode of [0, 1]) {
    const { run } = fixture('minecraft:iron_golem', 'body', massMode);
    const water = step(run, () => 'water'), lava = step(run, () => 'lava');
    const mixed = step(run, x => x < 0 ? 'water' : 'lava');
    assert(Math.abs(mixed.b0vy - (water.b0vy + lava.b0vy) / 2) < 1e-12);
    assert(mixed.b0wz > 0, 'Denser liquid on the right must rotate that side upward');
    assert(Math.abs(mixed.b0wz + step(run, x => x < 0 ? 'lava' : 'water').b0wz) < 1e-12);
    for (const scale of [.25, .5, 2, 4]) {
      const scaled = step(run, x => x < 0 ? 'water' : 'lava', scale);
      assert.equal(scaled.b0vy, mixed.b0vy, 'Scaling must not turn sinking into floating');
      assert(Math.abs(scaled.b0wz * scale - mixed.b0wz) < 1e-12, 'Torque uses consistently scaled inertia');
    }
  }
});

test('material mass and inertia are consistent, preserve authored bounce, and leave custom mobs organic', () => {
  const metal = fixture('minecraft:iron_golem'), normal = fixture('addon:iron_golem');
  assert.deepEqual(normal.rig.bodies[0], { ...normal.original.bodies[0], material: 'organic', liquidDensity: materials.organic.density });
  const body = metal.rig.bodies[0], source = metal.original.bodies[0];
  assert(body.mass > source.mass * 9);
  assert(Math.abs(body.mass * body.inverseMass - 1) < 1e-12);
  assert(Math.abs(body.inverseInertia[0] * body.mass - source.inverseInertia[0] * source.mass) < 1e-12);
  assert.equal(body.restitution, source.restitution);
  assert.equal(bodyMaterial('minecraft:snow_golem', 'arm1'), 'wood');
  assert.equal(bodyMaterial('minecraft:snow_golem', 'head'), 'snow', 'Carved pumpkin is not a separate physical body');
  assert.equal(bodyMaterial('minecraft:guardian', 'body'), 'organic');
  assert.equal(bodyMaterial('minecraft:warden', 'body'), 'organic');
  // Symbolic head dimensions must not destroy the chosen sampling axis.
  const adapted = structuredClone(normal.rig);
  adapted.shapes[0] = { ...adapted.shapes[0], half: ['8*v.head_scale', '4*v.head_scale', '4*v.head_scale'] };
  assert.equal(waterLayout(adapted)[0].axis, 0);
  const scaled = worldRig(metal.rig).bodies[0];
  const value = expression => script('return ' + expression + ';')({ body_units2: 4, body_units3: 8 }, {}, {}, testMath, {});
  assert(Math.abs(value(scaled.mass) * value(scaled.inverseMass) - 1) < 1e-12);
});

test('emitted contact solver applies material friction and keeps heavy bodies supported by the floor', () => {
  const geometry = { bones: [{ name: 'body', pivot: [0, 0, 0], cubes: [{ origin: [-4, 0, -4], size: [8, 8, 8] }] }] };
  const config = { formatVersion: 1, api: Object.fromEntries(BP_API_METHODS.map(key => [key, false])), trigger: '!q.is_alive', release: 'q.is_alive',
    simulation: { frequency: 20, sleep: { speed: .001 }, terrain: { friction: .001 } }, bodies: { body: { bone: 'body', mass: 10 } } };
  function slide(entity) {
    const rig = materialRig(normalizeModel(config, { geometries: new Map([['demo', geometry]]) }, { geometry: { default: 'demo' } }), entity);
    // A nonrotating slider on smooth ground isolates sliding friction from
    // tipping/rolling and from both materials immediately coming to rest.
    rig.bodies[0].inverseInertia = [0, 0, 0];
    const raw = materialProgram(createProgram({ ...rig, api: apiSettings() }, { preview: true }), rig); waterProgram(raw, rig);
    const program = specializeApi(raw, rig.api), runs = program.frameChunks.map(chunk => script(emit(chunk)));
    const v = {}, q = { is_alive: 1, life_time: 0, delta_time: 0, frame_alpha: 1, model_scale: .0625,
      death_ticks: 0, body_y_rotation: 0, position: () => 0,
      bone_orientation_trs: () => ({ t: { x: 0, y: 0, z: 0 }, r: { x: 0, y: 0, z: 0 }, s: { x: 1, y: 1, z: 1 } }),
      relative_block_has_any_tag: (_x, y, _z, ...tags) => +(y < 0 && !tags.includes('water') && !tags.includes('lava')) };
    script(emit(program.initialize))(v, {}, q, testMath, {});
    const frame = dt => { q.delta_time = dt; q.life_time += dt; for (const run of runs) run(v, {}, q, testMath, {}); };
    frame(0); frame(0); q.is_alive = 0; frame(0); assert.equal(v.active, 1);
    v.b0vx = 3;
    let minY = Infinity;
    for (let i = 0; i < 100; i++) { frame(.05); minY = Math.min(minY, v.b0y); }
    assert(Number.isFinite(v.b0x)); assert(minY > .15, entity + ': floor support must survive material mass scaling');
    return v.b0x;
  }
  const snow = slide('minecraft:snow_golem'), wood = slide('minecraft:creaking');
  assert(snow > wood + .01, `Snow must slide further than rough wood under identical starting velocity: snow=${snow}, wood=${wood}`);
  slide('minecraft:iron_golem'); slide('minecraft:copper_golem');
});
