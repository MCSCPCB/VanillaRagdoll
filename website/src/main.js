import 'oreui-web/styles.css';
import 'oreui-web/button';
import 'oreui-web/card';
import 'oreui-web/progress-bar';
import './styles.css';

const $ = id => document.getElementById(id);
const fallbackURL = new URL(import.meta.env.BASE_URL + 'pack_icon.png', document.baseURI).href;
let worker = null, generation = 0, downloadURL = null, iconURLs = [], busy = false;
const size = bytes => bytes < 1024 ** 2 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
const announce = text => { $('announcement').textContent = text; };
const disposeURLs = () => { if (downloadURL) URL.revokeObjectURL(downloadURL); downloadURL = null; iconURLs.forEach(URL.revokeObjectURL); iconURLs = []; $('download').href = undefined; };

function reset() {
  generation++; worker?.terminate(); worker = null; busy = false; disposeURLs();
  $('processing').hidden = true; $('result').hidden = true; $('error').hidden = true; $('drop-zone').hidden = false;
  $('file-input').value = ''; $('pack-list').replaceChildren(); $('report-content').replaceChildren(); $('report').open = false;
  $('drop-zone').classList.remove('drag-over');
}
function error(message) {
  worker?.terminate(); worker = null; busy = false;
  $('processing').hidden = true; $('drop-zone').hidden = false;
  $('error').hidden = false; $('error').textContent = message;
}
function item(tag, text, className) {
  const el = document.createElement(tag); el.textContent = text; if (className) el.className = className; return el;
}
function showResult(result) {
  worker?.terminate(); worker = null; busy = false;
  $('processing').hidden = true; $('result').hidden = false;
  const downloadable = !!result.download;
  $('result-title').textContent = downloadable ? '补丁已生成' : '没有可生成的实体';
  $('result-symbol').textContent = downloadable ? '✓' : '−';
  $('result-summary').textContent = `已适配 ${result.successful} 个实体${result.skipped ? ` · ${result.skipped} 项已跳过` : ''}`;
  $('download').hidden = !downloadable; $('install-note').hidden = !downloadable;
  if (downloadable) {
    downloadURL = URL.createObjectURL(new Blob([result.download.data], { type: 'application/zip' }));
    $('download').href = downloadURL; $('download').download = result.download.name;
    $('download').textContent = `下载补丁 · ${size(result.download.data.byteLength)}`;
  }
  for (const report of result.reports) {
    if (report.file) {
      const row = item('div', '', 'pack-row'), img = document.createElement('img');
      img.src = packIcons.get(report.index) ?? fallbackURL; img.alt = ''; img.width = img.height = 48;
      const text = item('div', ''); text.append(item('strong', report.pack + ' Ragdoll'), item('span', `${report.successful.length} 个实体 · ${report.file}`, 'muted'));
      row.append(img, text); $('pack-list').append(row);
    }
    const group = item('section', '', 'report-group'); group.append(item('h4', report.pack));
    for (const s of report.skipped) group.append(item('p', `${s.name}：${s.reason}`, 'report-skip'));
    if (report.successful.length) { const list = document.createElement('details'); list.append(item('summary', `已适配的实体 (${report.successful.length})`), item('p', report.successful.map(s => s.name).join('、'))); group.append(list); }
    $('report-content').append(group);
  }
  for (const warning of result.warnings) $('report-content').append(item('p', `${warning.name}：${warning.reason}`, 'report-skip'));
  $('report').hidden = false;
  $('report-title').textContent = result.skipped || result.warnings.length ? '查看处理详情与跳过原因' : '查看已适配的实体';
  if (!downloadable) $('report').open = true;
  announce($('result-title').textContent + '。' + $('result-summary').textContent);
  $('result-title').focus({ preventScroll: true });
}

let packIcons = new Map(), lastStage = '', progressValue = 0;
async function processFile(file) {
  if (!file) return;
  reset(); const current = generation;
  if (!/\.(zip|mcpack|mcaddon)$/i.test(file.name)) { error('请选择 .zip、.mcpack 或 .mcaddon 文件'); return; }
  if (file.size > 256 * 1024 ** 2) { error('文件超过 256 MB，请分别处理其中的资源包'); return; }
  busy = true; packIcons = new Map(); lastStage = ''; progressValue = 0;
  $('drop-zone').hidden = true; $('processing').hidden = false; $('filename').textContent = `${file.name} · ${size(file.size)}`;
  $('progress').value = 0; $('progress').label = '正在读取'; $('progress-detail').textContent = '正在打开文件';
  announce('开始处理 ' + file.name);
  try {
    const [buffer, fallbackIcon] = await Promise.all([file.arrayBuffer(), fetch(fallbackURL).then(r => { if (!r.ok) throw new Error(); return r.arrayBuffer(); }).then(b => new Uint8Array(b)).catch(() => undefined)]);
    if (current !== generation) return;
    worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    worker.onerror = () => { if (current === generation) error('处理程序意外停止。请关闭占用内存的其他页面，或分别处理资源包后重试'); };
    worker.onmessage = ({ data }) => {
      if (current !== generation) return;
      if (data.type === 'error') { error(data.message); return; }
      if (data.type === 'result') { showResult(data.result); return; }
      const e = data.event;
      if (e.packs) for (const [i, p] of e.packs.entries()) if (p.icon) { const url = URL.createObjectURL(new Blob([p.icon], { type: 'image/png' })); iconURLs.push(url); packIcons.set(i, url); }
      const labels = { reading: '读取资源包', inspecting: '检查实体', generating: '生成布娃娃', packing: '打包补丁' };
      const stage = labels[e.stage] ?? '正在处理';
      if (stage !== lastStage) { announce(stage); lastStage = stage; }
      const part = e.stage === 'packing' ? 0.85 + (e.percent ?? 0) / 100 * 0.15 : (e.current ?? 0) / Math.max(1, e.total ?? 1) * 0.85;
      progressValue = Math.max(progressValue, e.packCount ? 5 + ((e.packIndex + part) / e.packCount) * 94 : e.stage === 'reading' ? 2 : 5);
      $('progress').value = progressValue; $('progress').label = stage;
      $('progress-detail').textContent = (e.packCount > 1 ? `${e.packIndex + 1}/${e.packCount} · ` : '') + (e.message ?? stage);
    };
    worker.postMessage({ buffer, name: file.name, fallbackIcon }, [buffer]);
  } catch { if (current === generation) error('无法读取文件，请重新选择后重试'); }
}

$('choose').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', e => processFile(e.target.files[0]));
$('cancel').addEventListener('click', () => { reset(); announce('已取消处理'); $('choose').focus(); });
$('again').addEventListener('click', () => { reset(); $('file-input').click(); });
for (const name of ['dragover', 'drop']) window.addEventListener(name, e => e.preventDefault());
$('drop-zone').addEventListener('dragover', () => $('drop-zone').classList.add('drag-over'));
$('drop-zone').addEventListener('dragleave', e => { if (!$('drop-zone').contains(e.relatedTarget)) $('drop-zone').classList.remove('drag-over'); });
$('drop-zone').addEventListener('drop', e => {
  $('drop-zone').classList.remove('drag-over'); if (busy) return;
  if (e.dataTransfer.files.length !== 1) { error('请一次选择一个文件；多个包可以放入同一个 ZIP 中'); return; }
  processFile(e.dataTransfer.files[0]);
});
window.addEventListener('pagehide', () => { generation++; worker?.terminate(); disposeURLs(); });
