import JSZip from 'jszip';
import { parseJson } from '../../vendor/simple-ragdoll/src/resources.js';

export const limits = { upload: 256 * 1024 ** 2, expanded: 512 * 1024 ** 2, files: 20000, packs: 32, depth: 3 };
export class InputError extends Error {}
const decoder = new TextDecoder();
const json = bytes => parseJson(decoder.decode(bytes));
export const extension = name => name.split('.').at(-1).toLowerCase();
export const fileStem = name => name.replace(/^.*[\\/]/, '').replace(/\.(zip|mcaddon|mcpack)$/i, '');
export const cleanName = name => String(name).replace(/§[0-9a-z]/gi, '').replace(/[\x00-\x1f\x7f]/g, '').trim();
export const safeFilename = name => (cleanName(name).replace(/[<>:"/\\|?*]/g, '_').replace(/[. ]+$/g, '').slice(0, 120) || 'Addon') + '.mcpack';
export const validUUID = s => typeof s === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(s);
export const validVersion = v => Array.isArray(v) && v.length === 3 && v.every(n => Number.isInteger(n) && n >= 0);

export function languageTable(text) {
  const table = new Map();
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    const eq = line.indexOf('='); if (eq < 1) continue;
    table.set(line.slice(0, eq).trim(), line.slice(eq + 1).replace(/\s*##.*$/, '').trim());
  }
  return table;
}

export function englishName(manifest, files, fallback) {
  const raw = manifest.header?.name;
  if (typeof raw !== 'string' || !raw.trim()) return cleanName(fallback) || 'Addon';
  const languages = [...files.keys()].filter(p => /^texts\/en[_-][\w-]+\.lang$/i.test(p));
  languages.sort((a, b) => {
    const priority = p => /en_us/i.test(p) ? 0 : /en_gb/i.test(p) ? 1 : 2;
    return priority(a) - priority(b) || a.localeCompare(b);
  });
  for (const path of languages) {
    const value = languageTable(decoder.decode(files.get(path))).get(raw);
    if (value) return cleanName(value) || cleanName(fallback) || 'Addon';
  }
  return /^pack[._]/i.test(raw) ? cleanName(fallback) || 'Addon' : cleanName(raw) || 'Addon';
}

export function usableIcon(bytes) {
  if (!bytes || bytes.length < 24 || bytes.length > 4 * 1024 ** 2) return false;
  if (![137, 80, 78, 71, 13, 10, 26, 10].every((n, i) => bytes[i] === n)) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getUint32(16) > 0 && view.getUint32(16) <= 4096 && view.getUint32(20) > 0 && view.getUint32(20) <= 4096;
}

// Preserve the RP boundaries: a BP+RP addon is one output, independent RPs are separate.
export async function readUpload(data, filename, progress = () => {}) {
  if (!['zip', 'mcpack', 'mcaddon'].includes(extension(filename))) throw new InputError('请选择 ZIP、MCPACK 或 MCADDON 文件');
  if (data.byteLength > limits.upload) throw new InputError('文件超过 256 MB，请分别处理其中的资源包');
  const packs = [], warnings = []; let total = 0, count = 0;
  async function scan(bytes, label, depth) {
    if (depth > limits.depth) throw new InputError('压缩包嵌套过深，请直接选择其中的资源包');
    let zip;
    try { zip = await JSZip.loadAsync(bytes); } catch { throw new InputError('无法读取压缩包，请确认文件完整且未加密'); }
    const entries = Object.values(zip.files).filter(e => !e.dir), paths = new Set();
    for (const entry of entries) {
      const path = entry.unsafeOriginalName ?? entry.name;
      if (path.includes('\\') || path.startsWith('/') || path.includes(':') || path.split('/').some(p => p === '..' || p === '.' || !p)) throw new InputError('压缩包包含无效文件路径');
      if (paths.has(path.toLowerCase())) throw new InputError('压缩包包含重复或大小写冲突的文件路径');
      paths.add(path.toLowerCase());
      total += entry._data?.uncompressedSize ?? 0; count++;
      if (total > limits.expanded || count > limits.files) throw new InputError('解压后的资源过大，请分别处理其中的资源包');
    }
    const roots = entries.filter(e => /(^|\/)manifest\.json$/i.test(e.name)).map(e => e.name.slice(0, -13));
    for (const prefix of roots) {
      const manifestEntry = entries.find(e => e.name.toLowerCase() === (prefix + 'manifest.json').toLowerCase());
      let manifest;
      try { manifest = json(await manifestEntry.async('uint8array')); } catch { warnings.push({ name: label + '/' + prefix, reason: '清单无法解析，已跳过该包' }); continue; }
      if (!manifest || !Array.isArray(manifest.modules)) { warnings.push({ name: label + '/' + prefix, reason: '清单模块格式无效，已跳过该包' }); continue; }
      const types = manifest.modules.map(m => m?.type);
      if (!types.includes('resources') && !types.includes('data')) continue;
      if (!validUUID(manifest.header?.uuid) || !validVersion(manifest.header?.version)) { warnings.push({ name: label + '/' + prefix, reason: '清单缺少有效的 UUID 或版本，已跳过该包' }); continue; }
      if (packs.length >= limits.packs) throw new InputError('一个文件中的包太多，请分开处理');
      const files = new Map();
      for (const e of entries) {
        if (!e.name.startsWith(prefix) || roots.some(r => r !== prefix && r.startsWith(prefix) && e.name.startsWith(r))) continue;
        const path = e.name.slice(prefix.length);
        if (/^manifest\.json$/i.test(path) || /^(entity|entities|models|animations|animation_controllers|render_controllers)\/.*\.json$/i.test(path) || /^texts\/en[_-][\w-]+\.lang$/i.test(path) || /^pack_icon\.png$/i.test(path)) {
          const content = await e.async('uint8array');
          if (content.length !== e._data.uncompressedSize) throw new InputError('压缩包文件长度异常');
          files.set(path, content);
        }
      }
      const fallback = prefix.replace(/\/$/, '').split('/').at(-1) || fileStem(label);
      const name = englishName(manifest, files, fallback);
      const icon = [...files].find(([p]) => /^pack_icon\.png$/i.test(p))?.[1];
      packs.push({ manifest, files, name, icon: usableIcon(icon) ? icon : null, type: types.includes('resources') ? 'resources' : 'data', label });
      progress({ stage: 'reading', message: '正在读取 ' + name });
    }
    for (const e of entries) if (/\.(mcpack|mcaddon|zip)$/i.test(e.name) && !roots.some(r => e.name.startsWith(r))) await scan(await e.async('uint8array'), e.name, depth + 1);
  }
  await scan(data, filename, 0);
  const resourcePacks = packs.filter(p => p.type === 'resources');
  if (!resourcePacks.length) throw new InputError('没有找到可读取的资源包。请提供包含实体定义和模型的资源包，或完整附加包');
  const ids = new Set();
  for (const p of resourcePacks) {
    if (ids.has(p.manifest.header.uuid.toLowerCase())) throw new InputError('文件中包含同一资源包的多个版本，请只保留一个版本');
    ids.add(p.manifest.header.uuid.toLowerCase());
  }
  return { resourcePacks, behaviorPacks: packs.filter(p => p.type === 'data'), warnings };
}
