import { message, errorMessage } from './messages.mjs';
import JSZip from 'jszip';
import { readUpload, safeFilename, fileStem } from './archive.mjs';
import { inspectPack, behaviorIndex } from './inspect.mjs';
import { compileEntities } from './compile.mjs';

const encoder = new TextEncoder();
export async function digest(value) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))].map(n => n.toString(16).padStart(2, '0')).join('');
}
export async function patchUUID(original, kind) {
  const h = await digest('simple-ragdoll-web-v1:' + original.toLowerCase() + ':' + kind);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
const maxVersion = v => Array.isArray(v) && v.reduce((d, n, i) => d || n - ([1, 26, 50][i] ?? 0), 0) > 0 ? v : [1, 26, 50];

export async function generate(data, filename, { progress = () => {}, fallbackIcon } = {}) {
  // Stable UUID plus a newer version lets Bedrock replace an earlier generated patch.
  // Split seconds into 16-bit components to stay within manifest version bounds.
  const seconds = Math.floor(Date.now() / 1000), version = [1, Math.floor(seconds / 65536), seconds % 65536];
  const input = await readUpload(data, filename, progress), behaviors = behaviorIndex(input.behaviorPacks), results = [], reports = [], usedNames = new Set();
  progress({ stage: 'inspecting', message: message('progress_inspecting'), packs: input.resourcePacks.map(p => ({ name: p.name, icon: p.icon })) });
  for (let i = 0; i < input.resourcePacks.length; i++) {
    const pack = input.resourcePacks[i];
    const packProgress = event => progress({ ...event, pack: pack.name, packIndex: i, packCount: input.resourcePacks.length });
    try {
      const inspection = inspectPack(pack, behaviors), token = 'web_' + (await digest(pack.manifest.header.uuid.toLowerCase())).slice(0, 16);
      const output = await compileEntities(inspection, token, packProgress);
      const report = { pack: pack.name, index: i, successful: output.successful, skipped: output.skipped, file: null };
      if (!output.successful.length) { if (!report.skipped.length) report.skipped.push({ name: pack.name, reason: message('no_compatible_mobs') }); reports.push(report); continue; }
      const zip = new JSZip();
      for (const [path, value] of output.files) zip.file(path, JSON.stringify(value, null, path.endsWith('_gate.json') ? 2 : undefined));
      const name = pack.name + ' Ragdoll';
      zip.file('manifest.json', JSON.stringify({ format_version: 2, header: { name, description: 'Simple Ragdoll', uuid: await patchUUID(pack.manifest.header.uuid, 'header'), version, min_engine_version: maxVersion(pack.manifest.header.min_engine_version) }, modules: [{ type: 'resources', uuid: await patchUUID(pack.manifest.header.uuid, 'module'), version }], dependencies: [{ uuid: pack.manifest.header.uuid, version: pack.manifest.header.version }], metadata: { authors: ['Simple Ragdoll'], generated_with: { simple_ragdoll: ['0.1.3'], ragdoll_generator: ['1.0.0'] } } }, null, 2));
      if (pack.icon ?? fallbackIcon) zip.file('pack_icon.png', pack.icon ?? fallbackIcon);
      let outputName = safeFilename(name), suffix = 2;
      while (usedNames.has(outputName.toLowerCase())) outputName = safeFilename(name + ' (' + suffix++ + ')');
      usedNames.add(outputName.toLowerCase()); report.file = outputName;
      packProgress({ stage: 'packing', message: message('progress_packing', { name }) });
      const content = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } }, s => packProgress({ stage: 'packing', percent: s.percent, message: message('progress_packing', { name }) }));
      results.push({ name: outputName, data: content }); reports.push(report);
    } catch (e) { reports.push({ pack: pack.name, successful: [], skipped: [{ name: pack.name, reason: errorMessage(e) }], file: null }); }
  }
  const summary = { reports, warnings: input.warnings, successful: reports.reduce((n, r) => n + r.successful.length, 0), skipped: reports.reduce((n, r) => n + r.skipped.length, 0) };
  if (!results.length) return { ...summary, download: null };
  if (results.length === 1) return { ...summary, download: results[0] };
  const zip = new JSZip(); for (const r of results) zip.file(r.name, r.data);
  return { ...summary, download: { name: fileStem(filename).replace(/[<>:"/\\|?*]/g, '_') + ' Ragdoll.zip', data: await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }) } };
}
