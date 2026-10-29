import { indexResources, parseJson, descriptionOf } from '../../vendor/simple-ragdoll/src/resources.js';
import { autoConfig } from '../../vendor/simple-ragdoll/src/config.js';
import { normalizeModel } from '../../vendor/simple-ragdoll/src/core/model.mjs';
import { BP_API_METHODS } from '../../vendor/simple-ragdoll/src/core/api.mjs';
import { validateExpression } from './validate.mjs';

const decode = b => new TextDecoder().decode(b);
const reject = message => { throw new Error(message); };
const vector = x => Array.isArray(x) && x.length === 3 && x.every(n => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) < 100000);

// Check before autoConfig: its hierarchy traversal assumes a valid acyclic model.
export function checkGeometry(g) {
  if (!Array.isArray(g.bones) || !g.bones.length || g.bones.length > 256) reject('模型骨骼为空或超过自动处理范围');
  const names = new Map(); let cubes = 0;
  for (const b of g.bones) {
    if (typeof b.name !== 'string' || !/^[\w .:-]+$/.test(b.name) || names.has(b.name.toLowerCase())) reject('模型骨骼名称重复或无法安全查询');
    names.set(b.name.toLowerCase(), b);
    if (b.binding || b.poly_mesh) reject('暂不支持绑定表达式或多边形模型');
    for (const k of ['pivot', 'rotation']) if (b[k] !== undefined && !vector(b[k])) reject('模型包含无效的骨骼坐标');
    if (b.cubes !== undefined && !Array.isArray(b.cubes)) reject('模型方块结构无效');
    for (const c of b.cubes ?? []) {
      if (++cubes > 2048) reject('模型方块数量超过自动处理范围');
      if (!vector(c.origin) || !vector(c.size) || c.size.some(n => n < 0)) reject('模型方块坐标或尺寸无效');
      for (const k of ['pivot', 'rotation']) if (c[k] !== undefined && !vector(c[k])) reject('模型方块旋转无效');
      if (c.inflate !== undefined && (typeof c.inflate !== 'number' || !Number.isFinite(c.inflate))) reject('模型膨胀参数无效');
    }
  }
  const done = new Set(), visiting = new Set();
  function walk(b) {
    if (done.has(b.name)) return;
    if (visiting.has(b.name)) reject('模型骨骼存在循环连接');
    visiting.add(b.name);
    if (b.parent) {
      const parent = names.get(String(b.parent).toLowerCase());
      if (!parent || parent.name !== b.parent) reject('模型父骨骼不存在或大小写不一致');
      walk(parent);
    }
    visiting.delete(b.name); done.add(b.name);
  }
  g.bones.forEach(walk);
  if (!cubes) reject('模型没有可用的方块');
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
  if (typeof source !== 'string' || source.length > 2048 || depth > 8) reject('模型选择表达式超出自动处理范围');
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
  if (question < 0 || colon < 0) reject('无法可靠确定运行时使用的模型');
  const test = s.slice(0, question).trim();
  if (!test || /[;{}]/.test(test)) reject('模型选择条件无效');
  return [...geometryBranches(s.slice(question + 1, colon), `(${guard})&&(${test})`, depth + 1), ...geometryBranches(s.slice(colon + 1), `(${guard})&&!(${test})`, depth + 1)];
}

function selectVariants(client, resources) {
  const aliases = client.geometry ?? {}, entries = Object.entries(aliases);
  if (!entries.length || entries.some(([, id]) => typeof id !== 'string')) reject('没有可解析的模型引用');
  if (new Set(entries.map(([, id]) => id)).size === 1) return [{ geometry: entries[0][0] }];
  const renderers = new Map([...resources.json.values()].flatMap(v => Object.entries(v.render_controllers ?? {})));
  const selectors = [];
  for (const call of client.render_controllers ?? []) {
    // Simultaneous conditional geometry layers require a different capture strategy.
    if (typeof call !== 'string') reject('暂不自动处理多个条件渲染层的模型切换');
    const r = renderers.get(call); if (!r) reject('缺少用于判断模型切换的渲染控制器');
    selectors.push(geometryBranches(r.geometry));
  }
  if (!selectors.length || selectors.some(s => JSON.stringify(s) !== JSON.stringify(selectors[0]))) reject('多个渲染层使用不同模型，已保留原实体');
  const actual = new Map(entries.map(([alias]) => [alias.toLowerCase(), alias]));
  const grouped = new Map();
  for (const { alias, guard } of selectors[0]) {
    if (!actual.has(alias)) reject('渲染控制器引用了不存在的模型别名');
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
    try { value = parseJson(decode(bytes), path); } catch { excludedFiles.push({ name: path, reason: '原文件无法解析，未修改' }); continue; }
    const client = value?.['minecraft:client_entity']?.description;
    if (!value || typeof value !== 'object' || Array.isArray(value) || (value['minecraft:geometry'] !== undefined && !Array.isArray(value['minecraft:geometry']))) { excludedFiles.push({ name: path, reason: '原资源结构无法解析，未修改' }); continue; }
    const geometry = [...(value['minecraft:geometry'] ?? []).map(g => [g.description?.identifier, g]), ...Object.entries(value).filter(([id]) => id.startsWith('geometry.'))];
    const identity = client ? [['client', client.identifier, value]] : [...geometry.map(([id, g]) => ['geometry', id, g]), ...Object.entries(value.animations ?? {}).map(([id, a]) => ['animation', id, a]), ...Object.entries(value.animation_controllers ?? {}).map(([id, a]) => ['controller', id, a]), ...Object.entries(value.render_controllers ?? {}).map(([id, r]) => ['renderer', id, r])];
    if (identity.some(([, id]) => !id)) { excludedFiles.push({ name: path, reason: '原资源缺少标识符，未修改' }); continue; }
    for (const [kind, id, data] of identity) {
      const key = kind + ':' + id, serialized = JSON.stringify(data);
      if (ids.has(key) && (kind === 'client' || ids.get(key) !== serialized)) ambiguous.add(key);
      ids.set(key, serialized);
    }
    if (client) clientFiles.set(path, client.identifier);
    parsed.set(path, bytes);
  }
  for (const [path, id] of clientFiles) if (ambiguous.has('client:' + id)) parsed.delete(path);
  for (const key of ambiguous) if (key.startsWith('client:')) excludedFiles.push({ name: key.slice(7), reason: '原包重复定义了此实体，无法确定覆盖对象' });
  const resources = indexResources(parsed), accepted = [], skipped = [...excludedFiles];
  for (const [id, record] of resources.clients) {
    try {
      const client = descriptionOf(record);
      const seen = new Set();
      const checkReference = ref => {
        if (seen.has(ref)) return; seen.add(ref);
        if (['animation', 'controller'].some(kind => ambiguous.has(kind + ':' + ref))) reject('引用了存在歧义的重复动画资源：' + ref);
        const controller = resources.controllers.get(ref);
        for (const state of Object.values(controller?.states ?? {})) for (const call of state.animations ?? []) for (const alias of typeof call === 'string' ? [call] : Object.keys(call)) checkReference(client.animations?.[alias] ?? alias);
      };
      for (const ref of Object.values(client.animations ?? {})) checkReference(ref);
      for (const call of client.animation_controllers ?? []) for (const ref of Object.values(call)) checkReference(ref);
      for (const call of client.render_controllers ?? []) for (const ref of typeof call === 'string' ? [call] : Object.keys(call)) if (ambiguous.has('renderer:' + ref)) reject('引用了存在歧义的重复渲染控制器');
      if (!/^[a-z0-9_.-]+:[a-z0-9_./-]+$/i.test(id)) reject('实体标识符无效');
      if (id.startsWith('minecraft:')) reject('原版实体由 VanillaRagdoll 适配，未叠加自动配置');
      if (/\b(?:v|variable)\.(?:ragdoll_|vr_|rg[a-z0-9]+\b)/i.test(JSON.stringify(record.value))) reject('实体已有布娃娃或使用了保留变量，未重复注入');
      const bp = behaviors.get(id), bpText = JSON.stringify(bp ?? {});
      if (bp && !bpText.includes('"minecraft:health"')) reject('行为定义没有生命值组件，未为此实体添加死亡模拟');
      if (bp?.description?.runtime_identifier && /(?:player|dragon|wither|spider|slime|magma_cube|guardian)$/.test(bp.description.runtime_identifier)) reject('实体使用特殊原生渲染行为，未套用通用死亡补偿');
      for (const field of ['initialize', 'pre_animation', 'animate']) if (client.scripts?.[field] !== undefined && !Array.isArray(client.scripts[field])) reject('实体动画脚本结构不受支持');
      for (const field of ['initialize', 'pre_animation']) if ((client.scripts?.[field] ?? []).some(s => typeof s !== 'string' || s.length > 60000)) reject('原实体脚本过长或格式不受支持');
      for (const call of client.scripts?.animate ?? []) {
        if (typeof call === 'string') continue;
        if (!call || typeof call !== 'object' || Array.isArray(call)) reject('原实体的动画调用格式无法安全保留');
        for (const condition of Object.values(call)) {
          try { validateExpression(condition); } catch { reject('原实体使用复杂动画调用脚本，未自动改写'); }
        }
      }
      const variants = selectVariants(client, resources);
      if (variants.some(v => ambiguous.has('geometry:' + client.geometry[v.geometry]))) reject('引用了存在歧义的重复模型');
      const models = variants.map(v => resources.geometries.get(client.geometry[v.geometry]));
      if (models.some(g => !g)) reject('缺少实体模型；请上传包含模型的完整资源包');
      models.forEach(checkGeometry);
      const skeleton = g => JSON.stringify(g.bones.map(b => [b.name, b.parent ?? '']).sort((a, b) => a[0].localeCompare(b[0])));
      if (models.some(g => skeleton(g) !== skeleton(models[0]))) reject('切换模型的骨骼结构不一致，无法安全自动适配');
      const config = autoConfig(client, resources, variants);
      config.trigger = '!q.is_alive'; config.release = 'q.is_alive';
      config.api = Object.fromEntries(BP_API_METHODS.map(k => [k, false]));
      config.simulation = { initialVelocity: [1, 1, 1], initialSpin: 0 };
      config.outputLevel = 'standard';
      normalizeModel(config, resources, client);
      accepted.push({ id, record, config });
    } catch (e) { skipped.push({ name: id, reason: e.message }); }
  }
  return { resources, accepted, skipped };
}
