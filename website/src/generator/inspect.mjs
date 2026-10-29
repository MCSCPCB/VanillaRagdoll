import { message, reject, errorMessage } from './messages.mjs';
import { indexResources, parseJson, descriptionOf } from '../../vendor/simple-ragdoll/src/resources.js';
import { autoConfig } from '../../vendor/simple-ragdoll/src/config.js';
import { normalizeModel } from '../../vendor/simple-ragdoll/src/core/model.mjs';
import { BP_API_METHODS } from '../../vendor/simple-ragdoll/src/core/api.mjs';
import { validateExpression } from './validate.mjs';
import { lifecycle } from './lifecycle.mjs';
import { withVanillaResources, vanillaProfiles } from './vanilla.mjs';

const decode = b => new TextDecoder().decode(b);
const vector = x => Array.isArray(x) && x.length === 3 && x.every(n => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) < 100000);

// Check before autoConfig: its hierarchy traversal assumes a valid acyclic model.
export function checkGeometry(g) {
  if (!Array.isArray(g.bones) || !g.bones.length || g.bones.length > 256) reject('geometry_bone_count');
  const names = new Map(); let cubes = 0;
  for (const b of g.bones) {
    if (typeof b.name !== 'string' || !/^[\w .:-]+$/.test(b.name) || names.has(b.name.toLowerCase())) reject('geometry_bone_names');
    names.set(b.name.toLowerCase(), b);
    if (b.binding || b.poly_mesh) reject('geometry_binding');
    for (const k of ['pivot', 'rotation']) if (b[k] !== undefined && !vector(b[k])) reject('geometry_coordinates');
    if (b.cubes !== undefined && !Array.isArray(b.cubes)) reject('geometry_cubes');
    for (const c of b.cubes ?? []) {
      if (++cubes > 2048) reject('geometry_cube_count');
      if (!vector(c.origin) || !vector(c.size) || c.size.some(n => n < 0)) reject('geometry_cube_dimensions');
      for (const k of ['pivot', 'rotation']) if (c[k] !== undefined && !vector(c[k])) reject('geometry_cube_rotation');
      if (c.inflate !== undefined && (typeof c.inflate !== 'number' || !Number.isFinite(c.inflate))) reject('geometry_inflate');
    }
  }
  const done = new Set(), visiting = new Set();
  function walk(b) {
    if (done.has(b.name)) return;
    if (visiting.has(b.name)) reject('geometry_cycle');
    visiting.add(b.name);
    if (b.parent) {
      const parent = names.get(String(b.parent).toLowerCase());
      if (!parent || parent.name !== b.parent) reject('geometry_parent');
      walk(parent);
    }
    visiting.delete(b.name); done.add(b.name);
  }
  g.bones.forEach(walk);
  if (!cubes) reject('geometry_empty');
}

function unwrap(text) {
  let s = text.trim();
  while (s.startsWith('(') && s.endsWith(')')) {
    let depth = 0, outer = true;
    for (let i = 0; i < s.length - 1; i++) { if (s[i] === '(') depth++; if (s[i] === ')') depth--; if (!depth) { outer = false; break; } }
    if (!outer) break; s = s.slice(1, -1).trim();
  }
  return s;
}

// Resolve only explicit geometry aliases and ternaries; do not guess array semantics.
export function geometryBranches(source, guard = '1', depth = 0) {
  if (typeof source !== 'string' || source.length > 2048 || depth > 8) reject('selector_complex');
  const s = unwrap(source);
  const direct = /^(?:geometry|g)\.([\w]+)$/i.exec(s);
  if (direct) return [{ alias: direct[1].toLowerCase(), guard }];
  let brackets = 0, quote = false, question = -1, nested = 0, colon = -1;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "'") quote = !quote;
    if (quote) continue;
    if ('(['.includes(s[i])) brackets++; if (')]'.includes(s[i])) brackets--;
    if (brackets) continue;
    if (s[i] === '?' && s[i + 1] !== '?' && s[i - 1] !== '?') { if (question < 0) question = i; else nested++; }
    if (s[i] === ':' && question >= 0) { if (nested) nested--; else { colon = i; break; } }
  }
  if (question < 0 || colon < 0) reject('selector_unknown');
  const test = s.slice(0, question).trim();
  if (!test || /[;{}]/.test(test)) reject('selector_invalid');
  return [...geometryBranches(s.slice(question + 1, colon), `(${guard})&&(${test})`, depth + 1), ...geometryBranches(s.slice(colon + 1), `(${guard})&&!(${test})`, depth + 1)];
}

export function selectVariants(client, resources) {
  const aliases = client.geometry ?? {}, entries = Object.entries(aliases);
  if (!entries.length || entries.some(([, id]) => typeof id !== 'string')) reject('geometry_reference');
  if (new Set(entries.map(([, id]) => id)).size === 1) return [{ geometry: entries[0][0] }];
  const renderers = new Map([...resources.json.values()].flatMap(v => Object.entries(v.render_controllers ?? {})));
  const selectors = [];
  for (const call of client.render_controllers ?? []) {
    // Simultaneous conditional geometry layers require a different capture strategy.
    if (typeof call !== 'string') reject('selector_layers');
    const r = renderers.get(call); if (!r) reject('selector_renderer');
    selectors.push(geometryBranches(r.geometry));
  }
  const signature = s => JSON.stringify(s).toLowerCase().replace(/query\./g, 'q.').replace(/\s/g, '');
  if (!selectors.length || selectors.some(s => signature(s) !== signature(selectors[0]))) reject('selector_different_layers');
  const actual = new Map(entries.map(([alias]) => [alias.toLowerCase(), alias]));
  const grouped = new Map();
  for (const { alias, guard } of selectors[0]) {
    if (!actual.has(alias)) reject('selector_missing_alias');
    const name = actual.get(alias); grouped.set(name, [...(grouped.get(name) ?? []), guard]);
  }
  const variants = [...grouped].map(([geometry, guards]) => ({ geometry, when: guards.map(s => `(${s})`).join('||') }));
  delete variants.at(-1).when; return variants;
}

export function behaviorIndex(packs) {
  const result = new Map();
  for (const pack of packs) for (const [path, data] of pack.files) if (/^entities\/.*\.json$/i.test(path)) {
    try { const v = parseJson(decode(data))['minecraft:entity']; if (v?.description?.identifier) result.set(v.description.identifier, v); } catch { /* Existing BP errors are not rewritten. */ }
  }
  return result;
}

export function inspectPack(pack, behaviors) {
  const parsed = new Map(), excludedFiles = [], ids = new Map(), ambiguous = new Set(), clientFiles = new Map();
  for (const [path, bytes] of pack.files) {
    if (!/^(entity|models|animations|animation_controllers|render_controllers)\/.*\.json$/.test(path)) continue;
    let value;
    try { value = parseJson(decode(bytes), path); } catch { excludedFiles.push({ name: path, reason: message('source_parse') }); continue; }
    const client = value?.['minecraft:client_entity']?.description;
    if (!value || typeof value !== 'object' || Array.isArray(value) || (value['minecraft:geometry'] !== undefined && !Array.isArray(value['minecraft:geometry']))) { excludedFiles.push({ name: path, reason: message('source_structure') }); continue; }
    const geometry = [...(value['minecraft:geometry'] ?? []).map(g => [g.description?.identifier, g]), ...Object.entries(value).filter(([id]) => id.startsWith('geometry.'))];
    const identity = client ? [['client', client.identifier, value]] : [...geometry.map(([id, g]) => ['geometry', id, g]), ...Object.entries(value.animations ?? {}).map(([id, a]) => ['animation', id, a]), ...Object.entries(value.animation_controllers ?? {}).map(([id, a]) => ['controller', id, a]), ...Object.entries(value.render_controllers ?? {}).map(([id, r]) => ['renderer', id, r])];
    if (identity.some(([, id]) => !id)) { excludedFiles.push({ name: path, reason: message('source_identifier') }); continue; }
    for (const [kind, id, data] of identity) {
      const key = kind + ':' + id, serialized = JSON.stringify(data);
      if (ids.has(key) && (kind === 'client' || ids.get(key) !== serialized)) ambiguous.add(key);
      ids.set(key, serialized);
    }
    if (client) clientFiles.set(path, client.identifier);
    parsed.set(path, bytes);
  }
  for (const [path, id] of clientFiles) if (ambiguous.has('client:' + id)) parsed.delete(path);
  for (const key of ambiguous) if (key.startsWith('client:')) excludedFiles.push({ name: key.slice(7), reason: message('duplicate_client') });
  const resources = withVanillaResources(indexResources(parsed)), accepted = [], skipped = [...excludedFiles];
  for (const [id, record] of resources.clients) {
    try {
      const client = descriptionOf(record);
      const seen = new Set();
      const checkReference = ref => {
        if (seen.has(ref)) return; seen.add(ref);
        if (['animation', 'controller'].some(kind => ambiguous.has(kind + ':' + ref))) reject('ambiguous_animation', { id: ref });
        const controller = resources.controllers.get(ref);
        for (const state of Object.values(controller?.states ?? {})) for (const call of state.animations ?? []) for (const alias of typeof call === 'string' ? [call] : Object.keys(call)) checkReference(client.animations?.[alias] ?? alias);
      };
      for (const ref of Object.values(client.animations ?? {})) checkReference(ref);
      for (const call of client.animation_controllers ?? []) for (const ref of Object.values(call)) checkReference(ref);
      for (const call of client.render_controllers ?? []) for (const ref of typeof call === 'string' ? [call] : Object.keys(call)) if (ambiguous.has('renderer:' + ref)) reject('ambiguous_renderer');
      if (!/^[a-z0-9_.-]+:[a-z0-9_./-]+$/i.test(id)) reject('invalid_identifier');
      if (id.startsWith('minecraft:')) reject('vanilla_client');
      if (/\b(?:v|variable)\.(?:ragdoll_|vr_|rg[a-z0-9]+\b)/i.test(JSON.stringify(record.value))) reject('already_ragdoll');
      const bp = behaviors.get(id), bpText = JSON.stringify(bp ?? {});
      if (bp && !bpText.includes('"minecraft:health"')) reject('no_health');
      if (bp?.description?.runtime_identifier && /(?:player|dragon|wither|slime|magma_cube)$/.test(bp.description.runtime_identifier)) reject('special_runtime');
      for (const field of ['initialize', 'pre_animation', 'animate']) if (client.scripts?.[field] !== undefined && !Array.isArray(client.scripts[field])) reject('script_structure');
      for (const field of ['initialize', 'pre_animation']) if ((client.scripts?.[field] ?? []).some(s => typeof s !== 'string' || s.length > 60000)) reject('script_source');
      for (const call of client.scripts?.animate ?? []) {
        if (typeof call === 'string') continue;
        if (!call || typeof call !== 'object' || Array.isArray(call)) reject('animation_call_format');
        for (const condition of Object.values(call)) {
          try { validateExpression(condition); } catch { reject('animation_call_complex'); }
        }
      }
      const variants = selectVariants(client, resources);
      if (variants.some(v => ambiguous.has('geometry:' + client.geometry[v.geometry]))) reject('ambiguous_geometry');
      const models = variants.map(v => resources.geometries.get(client.geometry[v.geometry]));
      if (models.some(g => !g)) reject('geometry_missing');
      models.forEach(checkGeometry);
      const profiles = vanillaProfiles(client, variants, resources, bp);
      if (profiles) {
        for (const p of profiles) normalizeModel(p.config, resources, client);
        accepted.push({ id, record, profiles });
        continue;
      }
      if (bp?.description?.runtime_identifier && /(?:spider|guardian)$/.test(bp.description.runtime_identifier)) reject('custom_special_runtime');
      const skeleton = g => JSON.stringify(g.bones.map(b => [b.name, b.parent ?? '']).sort((a, b) => a[0].localeCompare(b[0])));
      if (models.some(g => skeleton(g) !== skeleton(models[0]))) reject('skeleton_mismatch');
      const config = autoConfig(client, resources, variants);
      config.trigger = lifecycle.trigger; config.release = lifecycle.release;
      config.api = Object.fromEntries(BP_API_METHODS.map(k => [k, false]));
      config.simulation = { initialVelocity: [1, 1, 1], initialSpin: 0 };
      config.outputLevel = 'standard';
      normalizeModel(config, resources, client);
      accepted.push({ id, record, config });
    } catch (e) { skipped.push({ name: id, reason: errorMessage(e) }); }
  }
  return { resources, accepted, skipped };
}
