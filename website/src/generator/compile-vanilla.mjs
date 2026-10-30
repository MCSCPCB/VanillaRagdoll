import { message, GeneratorError, errorMessage } from './messages.mjs';
import { normalizeModel } from '../../vendor/simple-ragdoll/src/core/model.mjs';
import { createProgram } from '../../vendor/simple-ragdoll/src/core/program.mjs';
import { terrainRecoveryProgram } from '../../vendor/simple-ragdoll/src/core/terrain-recovery.mjs';
import { compilePrograms, compileSpecializedPrograms, structureKey } from '../../vendor/simple-ragdoll/src/core/compute.mjs';
import { specializeApi } from '../../vendor/simple-ragdoll/src/core/api-specialize.mjs';
import { apiSettings } from '../../vendor/simple-ragdoll/src/core/api.mjs';
import { clientSize } from '../../vendor/simple-ragdoll/src/core/space.mjs';
import { resourceVariables } from '../../vendor/simple-ragdoll/src/export.js';
import { gateLifecycle, gateNames, patchGate, installGate } from './gate.mjs';
import { renderersOf } from './vanilla.mjs';
import { motionReserved, motionInitialize, motionFrame, motionProgram } from './initial-motion.mjs';
import { waterProgram } from './water-buoyancy.mjs';
import { cameraPushProgram } from './camera-push.mjs';
import { materialRig, materialProgram } from './materials.mjs';
import { animationFile, validateMolang, validateProgram, guardOutput } from './program-validation.mjs';
import { vanillaAnimationStack } from './vanilla/vanilla-animation-stack.mjs';
import { basePoseAnimations } from './vanilla/base-pose.mjs';
import { localPoseCache } from './vanilla/pose-cache.mjs';
import { needsLocalPose, entityRelativeBones } from './vanilla/pose-routing.mjs';
import { decorationPlan, decorationAnimation } from './vanilla/decorations.mjs';
import { articulationRig, articulationProgram } from './vanilla/articulation.mjs';
import { gameplayRig, gameplayProgram, gameplayAnimation } from './vanilla/gameplay-fixes.mjs';
import { contactProgram, coreTerrainOnly } from './vanilla/contact-performance.mjs';
import { needsNativeCatTail, catTailPose, catTailOutput } from './vanilla/cat-native.mjs';

const runtimeNames = ['profile', 'next', 'switch', 'kernel', 'enabled', 'run', 'seen', 'ready', 'last_x', 'last_y', 'last_z', 'units', 'arms_open'];
function rewrite(value, deathRoll, pose) {
  if (typeof value === 'string') {
    if (pose && value.startsWith('q.bone_orientation_trs(')) return value.slice('q.bone_orientation_trs('.length, -1).replace(/'([^']+)'/g, (_, name) => {
      const query = pose.queries.get(name.toLowerCase()); if (!query) throw new GeneratorError('native_capture_bone', { bone: name }); return query;
    });
    return value.includes('math.lerp(v.death_previous') ? value.replace(/\*90/g, '*' + deathRoll) : value;
  }
  if (Array.isArray(value)) return value.map(v => rewrite(v, deathRoll, pose));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rewrite(v, deathRoll, pose)]));
  return value;
}

function prepare(item, spec, index, resources, name, reserved) {
  const client = item.record.value['minecraft:client_entity'].description;
  const entity = { id: spec.native?.entity ?? item.id }, profile = { key: spec.native?.key, geometry: spec.native?.alias ?? spec.profile.geometry };
  let rig = materialRig(normalizeModel({ ...spec.config, ...gateLifecycle }, resources, client), spec.native?.entity);
  if (spec.native) rig = gameplayRig(articulationRig(rig, entity, profile), client);
  const decorations = spec.native ? decorationPlan(resources, client, rig, index) : [];
  const geometry = resources.geometries.get(rig.variants[0].geometry);
  const nativeCat = spec.native && needsNativeCatTail(entity, profile);
  const pose = spec.native && needsLocalPose(entity, profile) ? localPoseCache(geometry, rig, index, { activationOnly: true, entityRelative: entityRelativeBones(entity, resources, client) }) : nativeCat ? catTailPose(rig, index) : null;
  reserved.push(...decorations.map(f => f.name), ...(pose?.reserved ?? []));
  let raw = materialProgram(createProgram({ ...rig, api: apiSettings() }, { preview: true, terrainRecovery: false, reservedNames: reserved }), rig);
  if (spec.native) raw = contactProgram(gameplayProgram(articulationProgram(raw, rig, entity, profile), rig, entity, client), rig, entity, profile);
  if (nativeCat) catTailOutput(raw, rig, pose);
  motionProgram(raw, rig);
  waterProgram(raw, rig);
  terrainRecoveryProgram(raw, rig, {
    shapeIndices: spec.native && coreTerrainOnly(entity, profile) ? rig.shapes.flatMap((s, i) => rig.bodies[s.body].bone === 'body' ? [i] : []) : undefined,
  });
  cameraPushProgram(raw, rig);
  const program = specializeApi(rewrite(raw, spec.deathRoll, pose?.captureOnly ? null : pose), rig.api);
  for (const n of program.initialize.flat(Infinity)) if (n.kind === 'set') {
    if (n.name === 'v.frames' || n.name === 'v.has_position') n.value = 1;
    if (n.name === 'v.frame_to_world') n.value = 'v.vr_units';
    for (const k of ['x', 'y', 'z']) if (n.name === 'v.last_' + k) n.value = 'v.vr_last_' + k;
  }
  return { ...program, item, spec, entity, profile, index, name, rig, decorations, pose };
}

function patchRenderers(client, entries, resources, token, files) {
  if (!entries.some(e => e.spec.armsOpen)) return;
  const renderers = renderersOf(resources), clones = {}, folded = entries.filter(e => e.spec.native?.key === 'folded').map(e => `v.vr_profile==${e.index}`).join('||');
  const remap = new Map();
  const replace = id => {
    if (remap.has(id)) return remap.get(id);
    const source = renderers.get(id); if (!source) throw new GeneratorError('illager_renderer_missing', { id });
    const copy = structuredClone(source), name = `controller.render.ragdoll.${token}_${remap.size}`;
    if (renderers.has(name)) throw new GeneratorError('renderer_collision');
    // Append overrides so the last matching rule freezes arm visibility. The
    // inactive branch reproduces the source's last applicable visibility rule.
    for (const bone of ['arms', 'leftarm', 'rightarm']) {
      let normal = true;
      for (const item of source.part_visibility ?? []) for (const [pattern, value] of Object.entries(item)) {
        const re = new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*') + '$', 'i');
        if (re.test(bone)) normal = value;
      }
      (copy.part_visibility ??= []).push({ [bone]: `v.ragdoll_active?(${bone === 'arms' ? folded : '!(' + folded + ')'}):(${typeof normal === 'boolean' ? Number(normal) : normal})` });
    }
    clones[name] = copy; remap.set(id, name); return name;
  };
  client.render_controllers = client.render_controllers.map(call => typeof call === 'string' ? replace(call) : Object.fromEntries(Object.entries(call).map(([id, condition]) => [replace(id), condition])));
  files.set(`render_controllers/sr_patch_${token}.json`, { format_version: '1.8.0', render_controllers: clones });
}

function patchClient(item, entries, resources, token, files, gate) {
  const value = structuredClone(item.record.value), c = value['minecraft:client_entity'].description, scripts = c.scripts ?? {};
  const { animations, normal } = vanillaAnimationStack(c), base = basePoseAnimations(resources, { ...c, animations }, normal);
  delete c.animation_controllers;
  let selector = String(entries.length - 1);
  for (let i = entries.length - 2; i >= 0; i--) selector = `(${entries[i].spec.profile.when})?${i}:(${selector})`;
  const initialize = [...(scripts.initialize ?? []), runtimeNames.map(k => `v.vr_${k}=${k === 'units' ? '.0625' : ['profile', 'kernel'].includes(k) ? -1 : 0};`).join('') + 'v.ragdoll_active=0;', motionInitialize];
  const arms = entries.find(e => e.spec.armsOpen)?.spec.armsOpen;
  const before = [
    'v.vr_enabled=!q.is_in_ui;(!v.vr_enabled)?{v.vr_profile=-1;v.vr_kernel=-1;v.ragdoll_active=0;};',
    ...(arms ? [`(v.vr_enabled&&!v.ragdoll_active&&q.is_alive)?{v.vr_arms_open=${arms};};`] : []),
    `v.vr_next=v.vr_enabled?(v.ragdoll_active?v.vr_profile:(${selector})):-1;v.vr_switch=v.vr_profile!=v.vr_next;v.vr_profile=v.vr_next;`,
    '(v.vr_switch)?{v.vr_seen=0;v.vr_ready=0;};',
    `v.vr_run=v.vr_enabled&&(v.ragdoll_active||(v.vr_seen>0&&(${gateLifecycle.trigger})));`, motionFrame(),
    '(v.vr_enabled&&!v.ragdoll_active&&!v.vr_run)?{v.vr_ready=0;v.vr_kernel=-1;};',
    `(v.vr_enabled&&!v.vr_run)?{v.vr_last_x=q.position(0);v.vr_last_y=q.position(1);v.vr_last_z=q.position(2);t.vr_actor_units=q.model_scale;t.vr_actor_units=t.vr_actor_units??0.0625;t.vr_size=${clientSize(c)};v.vr_units=(t.vr_actor_units>0?t.vr_actor_units:0.0625)*(t.vr_size>0?t.vr_size:1);v.vr_seen=1;};`];
  const compute = [], captures = [], baselines = [], decorations = [], outputs = [];
  for (const e of entries) {
    const gate = `v.vr_profile==${e.index}`, id = 'animation.ragdoll.' + e.name;
    if (e.pose) before.push(`(v.vr_switch&&${gate})?{${e.pose.initialize}};`);
    if (e.decorations.length) before.push(`(v.vr_switch&&${gate})?{${e.decorations.map(f => `${f.name}=${f.channel === 'scale' ? 1 : 0};`).join('')}};`);
    for (const source of e.program.initializeSources) before.push(`(v.vr_run&&!v.vr_ready&&${gate})?{${source}};`);
    before.push(`(v.vr_run&&!v.vr_ready&&${gate})?{v.vr_kernel=${e.kernel};v.vr_ready=1;};`);
    const addAnimation = (suffix, animation, condition, list) => {
      const alias = `vr_${suffix}_${e.index}`, animationId = id + '.' + suffix;
      if (resources.animations.has(animationId)) throw new GeneratorError('animation_collision');
      animations[alias] = animationId; list.push({ [alias]: condition });
      files.set(`animations/sr_patch_${e.name}_${suffix}.json`, animationFile({ [animationId]: animation }));
    };
    if (e.pose) {
      addAnimation('baseline', e.pose.baselineAnimation, `v.vr_enabled&&!v.ragdoll_active&&${gate}`, baselines);
      addAnimation('capture', e.pose.animation, `v.vr_enabled&&!v.ragdoll_active&&${gate}`, captures);
    }
    if (e.decorations.length) addAnimation('decorations', decorationAnimation(e.decorations, e.index), `v.vr_enabled&&${gate}`, decorations);
    const active = `v.vr_enabled&&v.ragdoll_active&&${gate}`;
    const animation = e.spec.native ? gameplayAnimation(e.program.animation(), c, e.program.names) : e.program.animation();
    if (e.entity.id === 'minecraft:breeze') animation.bones.tornado_body = { scale: 0 };
    addAnimation('pose', guardOutput(animation, active), active, outputs);
  }
  for (const e of entries) if (e.pose?.before?.trim()) before.push(e.pose.before);
  for (const e of entries) for (const source of e.program.preAnimationSources) before.push(`(v.vr_run&&v.vr_profile==${e.index})?{${source}};`);
  for (const k of new Set(entries.map(e => e.kernel))) entries.find(e => e.kernel === k).program.computeOrder.forEach((id, i) => {
    const alias = `vr_kernel_${k}_${i}`; animations[alias] = id; compute.push({ [alias]: `v.vr_run&&v.vr_kernel==${k}` });
  });
  const live = call => typeof call === 'string' ? (base.direct.has(call) ? call : { [call]: '!v.ragdoll_active' }) : Object.fromEntries(Object.entries(call).map(([key, weight]) => [key, base.direct.has(key) ? weight : `(!v.ragdoll_active)*(${typeof weight === 'boolean' ? Number(weight) : weight})`]));
  c.scripts = { ...scripts, initialize, pre_animation: [...(scripts.pre_animation ?? [])], animate: [...compute, ...baselines, ...normal.map(live), ...base.extras, ...captures, ...decorations, ...outputs], should_update_bones_and_effects_offscreen: `(${scripts.should_update_bones_and_effects_offscreen ?? 0})||(v.vr_enabled&&v.ragdoll_active)` };
  c.animations = animations;
  installGate(c, { gate, scope: token, path: `animations/sr_patch_${token}_prepare.json`, setup: before, files });
  if (new Set(entries.map(e => c.geometry[e.spec.profile.geometry])).size === 1) c.queryable_geometry = entries[0].spec.profile.geometry;
  else delete c.queryable_geometry;
  const versionAtLeast = (v, floor) => String(v ?? 0).split('.').map(Number).reduce((d, n, i) => d || n - (floor[i] ?? 0), 0) >= 0;
  if (!versionAtLeast(value.format_version, [1, 20, 60])) value.format_version = '1.20.60';
  if (!versionAtLeast(c.min_engine_version, [1, 26, 50])) c.min_engine_version = '1.26.50';
  // Check our added statements only; source scripts may span several entries.
  for (const source of before) validateMolang(source);
  patchRenderers(c, entries, resources, token, files);
  files.set(item.record.file, value);
}

export async function compileVanilla(items, resources, token, progress) {
  const files = new Map(), successful = [], skipped = [];
  let kernel = 0;
  const reserved = [...resourceVariables(resources), ...motionReserved, ...gateNames, ...runtimeNames.map(k => 'v.vr_' + k), 'v.vr_head_scale', 'v.ragdoll_active'];
  for (let start = 0; start < items.length; start += 4) {
    const groups = new Map(), pending = new Map(), checked = new Set(), kernels = new Map();
    for (let i = start; i < Math.min(items.length, start + 4); i++) {
      const item = items[i]; progress({ stage: 'generating', current: i, total: items.length, message: message('progress_mob', { name: item.id }) });
      await new Promise(resolve => setTimeout(resolve, 0));
      try {
        const entries = item.profiles.map((spec, index) => prepare(item, spec, index, resources, `${token}_n${i}_p${index}`, reserved));
        pending.set(item, entries);
        for (const entry of entries) { const key = structureKey(entry); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(entry); }
      } catch (e) { skipped.push({ name: item.id, reason: message('native_config_failed', { cause: errorMessage(e) }) }); }
    }
    function compile(group) {
      let programs;
      try { programs = compilePrograms(group, { reservedNames: reserved }); }
      catch {
        if (group.length > 1) { const mid = Math.ceil(group.length / 2); compile(group.slice(0, mid)); compile(group.slice(mid)); return; }
        try { programs = compileSpecializedPrograms(group, { reservedNames: reserved }); } catch (e) { group[0].error = errorMessage(e); return; }
      }
      const k = kernel++, animations = Object.fromEntries(Object.entries(programs[0].computeAnimations).map(([id, a]) => [id, { ...a, anim_time_update: `(!v.vr_run||v.vr_kernel!=${k})?{return 0;};` + a.anim_time_update }]));
      kernels.set(k, [`animations/sr_patch_${programs[0].computeName}_kernel.json`, animationFile(animations)]);
      group.forEach((entry, i) => { entry.program = programs[i]; entry.kernel = k; });
    }
    for (const group of groups.values()) compile(group);
    for (const [item, entries] of pending) try {
      for (const e of entries) { if (!e.program) throw new GeneratorError(e.error.code, e.error.params); validateProgram(e.program, checked); }
      const candidate = new Map();
      patchClient(item, entries, resources, entries[0].name, candidate, patchGate(token));
      for (const k of new Set(entries.map(e => e.kernel))) candidate.set(...kernels.get(k));
      for (const [path, value] of candidate) {
        if (path !== item.record.file && resources.files.has(path)) throw new GeneratorError('resource_path_collision');
        for (const [id, a] of Object.entries(value.animations ?? {})) {
          if (resources.animations.has(id)) throw new GeneratorError('animation_id_collision');
          if (a.anim_time_update) { if (!checked.has(a.anim_time_update)) validateMolang(a.anim_time_update); checked.add(a.anim_time_update); }
          for (const b of Object.values(a.bones ?? {})) for (const ch of ['position', 'rotation', 'scale']) for (const code of Array.isArray(b[ch]) ? b[ch] : [b[ch]]) validateMolang(code);
        }
      }
      for (const [path, value] of candidate) files.set(path, value);
      successful.push({ name: item.id, bodies: Math.max(...entries.map(e => e.rig.bodies.length)), joints: Math.max(...entries.map(e => e.rig.joints.length)), profiles: entries.length, source: 'vanilla' });
    } catch (e) { skipped.push({ name: item.id, reason: errorMessage(e) }); }
  }
  return { files, successful, skipped };
}
