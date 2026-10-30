import { message, GeneratorError, errorMessage } from './messages.mjs';
import { normalizeModel } from '../../vendor/simple-ragdoll/src/core/model.mjs';
import { createProgram } from '../../vendor/simple-ragdoll/src/core/program.mjs';
import { terrainRecoveryProgram } from '../../vendor/simple-ragdoll/src/core/terrain-recovery.mjs';
import { compilePrograms, compileSpecializedPrograms, structureKey } from '../../vendor/simple-ragdoll/src/core/compute.mjs';
import { specializeApi } from '../../vendor/simple-ragdoll/src/core/api-specialize.mjs';
import { apiSettings } from '../../vendor/simple-ragdoll/src/core/api.mjs';
import { clientSize } from '../../vendor/simple-ragdoll/src/core/space.mjs';
import { animationFile, validateMolang, validateProgram, guardOutput } from './program-validation.mjs';
import { adaptClient, resourceVariables } from '../../vendor/simple-ragdoll/src/export.js';
import { motionReserved, motionInitialize, motionFrame, motionProgram } from './initial-motion.mjs';
import { waterProgram } from './water-buoyancy.mjs';
import { materialRig, materialProgram } from './materials.mjs';
import { compileVanilla } from './compile-vanilla.mjs';
import { gateLifecycle, gateNames, gateDefinition, patchGate, installGate } from './gate.mjs';

const extraNames = ['v.vr_enabled', 'v.vr_run', 'v.vr_switch', 'v.vr_seen', 'v.vr_ready', 'v.vr_last_x', 'v.vr_last_y', 'v.vr_last_z', 'v.vr_units', 'v.ragdoll_active'];

function prepare(item, resources, name, reservedNames) {
  const client = item.record.value['minecraft:client_entity'].description;
  const rig = materialRig(normalizeModel({ ...item.config, ...gateLifecycle }, resources, client));
  // Match VanillaRagdoll's tested adapter order, then remove every disabled BP API.
  const raw = materialProgram(createProgram({ ...rig, api: apiSettings() }, { preview: true, terrainRecovery: false, reservedNames }), rig);
  motionProgram(raw, rig);
  waterProgram(raw, rig);
  terrainRecoveryProgram(raw, rig);
  const program = specializeApi(raw, rig.api);
  for (const n of program.initialize.flat(Infinity)) if (n.kind === 'set') {
    if (n.name === 'v.frames' || n.name === 'v.has_position') n.value = 1;
    if (n.name === 'v.frame_to_world') n.value = 'v.vr_units';
    for (const k of ['x', 'y', 'z']) if (n.name === 'v.last_' + k) n.value = 'v.vr_last_' + k;
  }
  return { ...item, name, rig, ...program };
}

function patchClient(entry, program, animationId, gate, files) {
  const original = entry.record.value['minecraft:client_entity'].description, scripts = original.scripts ?? {};
  const value = adaptClient(entry.record.value, entry.rig, program, animationId), c = value['minecraft:client_entity'].description;
  const enabled = '!q.is_in_ui';
  c.scripts.initialize = [...(scripts.initialize ?? []), 'v.vr_enabled=0;v.vr_run=0;v.vr_switch=0;v.vr_seen=0;v.vr_ready=0;v.vr_last_x=0;v.vr_last_y=0;v.vr_last_z=0;v.vr_units=0.0625;v.ragdoll_active=0;', motionInitialize];
  const setup = [
    `v.vr_enabled=${enabled};(!v.vr_enabled)?{v.vr_seen=0;v.vr_ready=0;v.ragdoll_active=0;};`,
    `v.vr_run=v.vr_enabled&&(v.ragdoll_active||(v.vr_seen>0&&(${entry.rig.trigger})));`,
    motionFrame(),
    '(v.vr_enabled&&!v.ragdoll_active&&!v.vr_run)?{v.vr_ready=0;};',
    `(v.vr_enabled&&!v.vr_run)?{v.vr_last_x=q.position(0);v.vr_last_y=q.position(1);v.vr_last_z=q.position(2);t.vr_actor_units=q.model_scale;t.vr_actor_units=t.vr_actor_units??0.0625;t.vr_size=${clientSize(original)};v.vr_units=(t.vr_actor_units>0?t.vr_actor_units:0.0625)*(t.vr_size>0?t.vr_size:1);v.vr_seen=1;};`,
    ...program.initializeSources.map(s => `(v.vr_run&&!v.vr_ready)?{${s}};`),
    '(v.vr_run&&!v.vr_ready)?{v.vr_ready=1;};',
    ...program.preAnimationSources.map(s => `(v.vr_run)?{${s}};`),
  ];
  c.scripts.animate = c.scripts.animate.map((call, i) => i < program.computeOrder.length ? { [call]: 'v.vr_run' } : call);
  c.scripts.animate[c.scripts.animate.length - 1] = { ragdoll_generated: 'v.vr_enabled&&v.ragdoll_active' };
  c.scripts.should_update_bones_and_effects_offscreen = `(${scripts.should_update_bones_and_effects_offscreen ?? 0})||(v.vr_enabled&&v.ragdoll_active)`;
  // Preserve a higher declared engine version from the input.
  const old = String(original.min_engine_version ?? '0').split('.').map(Number);
  if (old.reduce((d, n, i) => d || n - ([1, 26, 50][i] ?? 0), 0) <= 0) c.min_engine_version = '1.26.50';
  c.scripts.pre_animation = [...(scripts.pre_animation ?? [])];
  installGate(c, { gate, scope: entry.name, path: `animations/sr_patch_${entry.name}_prepare.json`, setup, files, enabled });
  return value;
}

const checked = new Set();

export async function compileEntities(inspection, token, progress = () => {}) {
  const { resources } = inspection, accepted = inspection.accepted.filter(item => !item.profiles), skipped = [...inspection.skipped], successful = [], files = new Map();
  const reservedNames = [...new Set([...resourceVariables(resources), ...motionReserved, ...gateNames, ...extraNames])];
  const gate = patchGate(token);
  if (resources.files.has(gate.path) || resources.animations.has(gate.id)) throw new GeneratorError('resource_collision');
  checked.clear();
  function compile(group) {
    let programs;
    try { programs = compilePrograms(group, { reservedNames }); }
    catch (e) {
      if (group.length > 1) { const middle = Math.ceil(group.length / 2); compile(group.slice(0, middle)); compile(group.slice(middle)); return; }
      try { programs = compileSpecializedPrograms(group, { reservedNames }); } catch (error) { skipped.push({ name: group[0].id, reason: message('compile_failed', { cause: errorMessage(error) }) }); return; }
    }
    let commonValid = false;
    for (const [i, entry] of group.entries()) {
      try {
        const program = programs[i], id = 'animation.ragdoll.' + entry.name;
        validateProgram(program, checked);
        if (resources.animations.has(id) || Object.keys(program.computeAnimations).some(k => resources.animations.has(k))) throw new GeneratorError('resource_collision');
        const candidate = new Map(), client = patchClient(entry, program, id, gate, candidate);
        const animation = guardOutput(program.animation(), 'v.vr_enabled&&v.ragdoll_active');
        for (const field of ['initialize', 'pre_animation']) for (const code of client['minecraft:client_entity'].description.scripts[field]) if (code.length >= 64000) throw new GeneratorError('script_length');
        const path = `animations/sr_patch_${entry.name}.json`;
        if (resources.files.has(path)) throw new GeneratorError('animation_path_collision');
        candidate.set(path, animationFile({ [id]: animation }));
        for (const [path, value] of candidate) {
          if (resources.files.has(path) || Object.keys(value.animations).some(id => resources.animations.has(id))) throw new GeneratorError('resource_collision');
        }
        candidate.set(entry.record.file, client);
        for (const [path, value] of candidate) files.set(path, value);
        successful.push({ name: entry.id, bodies: entry.rig.bodies.length, joints: entry.rig.joints.length }); commonValid = true;
      } catch (e) { skipped.push({ name: entry.id, reason: errorMessage(e) }); }
    }
    if (commonValid) {
      const path = `animations/sr_patch_${programs[0].computeName}_kernel.json`;
      if (resources.files.has(path)) throw new GeneratorError('kernel_path_collision');
      const animations = Object.fromEntries(Object.entries(programs[0].computeAnimations).map(([id, animation]) => {
        const source = '(!v.vr_run)?{return 0;};' + animation.anim_time_update;
        validateMolang(source);
        return [id, { ...animation, anim_time_update: source }];
      }));
      files.set(path, animationFile(animations));
    }
  }
  // Bound live compilation memory; compatible entities in each batch share a kernel.
  for (let start = 0; start < accepted.length; start += 8) {
    const groups = new Map();
    for (let i = start; i < Math.min(start + 8, accepted.length); i++) {
      const item = accepted[i];
      progress({ stage: 'generating', current: i, total: inspection.accepted.length, message: message('progress_mob', { name: item.id }) });
      await new Promise(resolve => setTimeout(resolve, 0));
      try {
        const entry = prepare(item, resources, token + '_e' + i, reservedNames), key = structureKey(entry);
        if (!groups.has(key)) groups.set(key, []); groups.get(key).push(entry);
      } catch (e) { skipped.push({ name: item.id, reason: message('config_failed', { cause: errorMessage(e) }) }); }
    }
    for (const group of groups.values()) compile(group);
    checked.clear();
  }
  const native = await compileVanilla(inspection.accepted.filter(item => item.profiles), resources, token, e => progress({ ...e, current: accepted.length + e.current, total: inspection.accepted.length }));
  for (const [path, value] of native.files) files.set(path, value);
  successful.push(...native.successful); skipped.push(...native.skipped);
  if (successful.length) files.set(gate.path, gateDefinition(gate.id));
  progress({ stage: 'generating', current: inspection.accepted.length, total: inspection.accepted.length, message: message('progress_complete') });
  return { files, successful, skipped };
}
