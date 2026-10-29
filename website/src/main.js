import 'oreui-web/styles.css';
import 'oreui-web/button';
import 'oreui-web/card';
import 'oreui-web/progress-bar';
import './styles.css';
import { getLang, setLang, t, messageText } from './i18n.js';
import { message } from './generator/messages.mjs';

const $ = id => document.getElementById(id);
const fallbackURL = new URL(import.meta.env.BASE_URL + 'pack_icon.png', document.baseURI).href;
let worker = null, generation = 0, downloadURL = null, iconURLs = [], busy = false;
let resultState = null, errorState = null, progressState = null, announcement = null;
let packIcons = new Map(), lastStage = '', progressValue = 0;
const size = bytes => bytes < 1024 ** 2 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
function announce(value) { announcement = value; $('announcement').textContent = value ? messageText(value) : ''; }
const disposeURLs = () => { if (downloadURL) URL.revokeObjectURL(downloadURL); downloadURL = null; iconURLs.forEach(URL.revokeObjectURL); iconURLs = []; $('download').href = undefined; };

function reset() {
  generation++; worker?.terminate(); worker = null; busy = false; disposeURLs();
  resultState = errorState = progressState = null; packIcons = new Map(); lastStage = ''; progressValue = 0; announce(null);
  $('processing').hidden = true; $('result').hidden = true; $('error').hidden = true; $('drop-zone').hidden = false;
  $('file-input').value = ''; $('pack-list').replaceChildren(); $('report-content').replaceChildren(); $('report').open = false;
  $('drop-zone').classList.remove('drag-over');
}
function error(value) {
  worker?.terminate(); worker = null; busy = false; errorState = value; progressState = null;
  $('processing').hidden = true; $('drop-zone').hidden = false;
  $('error').hidden = false; $('error').textContent = messageText(value);
}
function item(tag, text, className) {
  const el = document.createElement(tag); el.textContent = text; if (className) el.className = className; return el;
}
function resultSummary(result) { return t('summary', { count: result.successful }) + (result.skipped ? t('skipped', { count: result.skipped }) : ''); }
function renderResult() {
  const result = resultState, downloadable = !!result.download;
  const openLists = new Set([...$('report-content').querySelectorAll('details[open]')].map(el => el.dataset.report));
  const scroll = $('report-content').scrollTop;
  $('pack-list').replaceChildren(); $('report-content').replaceChildren();
  $('result-title').textContent = t(downloadable ? 'ready' : 'empty');
  $('result-symbol').textContent = downloadable ? '✓' : '−';
  $('result-summary').textContent = resultSummary(result);
  $('download').hidden = !downloadable; $('install-note').hidden = !downloadable;
  // Update only the label: OreUI owns an internal anchor beside this span.
  if (downloadable) $('download-label').textContent = t('download_size', { size: size(result.download.data.byteLength) });
  for (const [i, report] of result.reports.entries()) {
    if (report.file) {
      const row = item('div', '', 'pack-row'), img = document.createElement('img');
      img.src = packIcons.get(report.index) ?? fallbackURL; img.alt = ''; img.width = img.height = 48;
      const text = item('div', ''); text.append(item('strong', report.pack + ' Ragdoll'), item('span', t('pack_summary', { count: report.successful.length, file: report.file }), 'muted'));
      row.append(img, text); $('pack-list').append(row);
    }
    const group = item('section', '', 'report-group'); group.append(item('h4', report.pack));
    for (const s of report.skipped) group.append(item('p', t('issue', { name: s.name, reason: messageText(s.reason) }), 'report-skip'));
    if (report.successful.length) {
      const list = document.createElement('details'); list.dataset.report = String(i); list.open = openLists.has(String(i));
      list.append(item('summary', t('adapted', { count: report.successful.length })), item('p', report.successful.map(s => s.name).join(t('list_separator')))); group.append(list);
    }
    $('report-content').append(group);
  }
  for (const warning of result.warnings) $('report-content').append(item('p', t('issue', { name: warning.name, reason: messageText(warning.reason) }), 'report-skip'));
  $('report').hidden = false;
  $('report-title').textContent = t(result.skipped || result.warnings.length ? 'report_skips' : 'report_success');
  $('report-content').scrollTop = scroll;
}
function showResult(result) {
  worker?.terminate(); worker = null; busy = false; resultState = result; progressState = null;
  $('processing').hidden = true; $('result').hidden = false;
  if (result.download) {
    downloadURL = URL.createObjectURL(new Blob([result.download.data], { type: 'application/zip' }));
    $('download').href = downloadURL; $('download').download = result.download.name;
  } else $('report').open = true;
  renderResult();
  announcement = null; $('announcement').textContent = t(result.download ? 'ready' : 'empty') + t('sentence_separator') + resultSummary(result);
  $('result-title').focus({ preventScroll: true });
}
function renderProgress() {
  const e = progressState;
  $('progress').value = progressValue;
  $('progress').label = e ? t('stage_' + e.stage) : t('reading_initial');
  $('progress-detail').textContent = e ? (e.packCount > 1 ? `${e.packIndex + 1}/${e.packCount} · ` : '') + (e.message ? messageText(e.message) : t('stage_' + e.stage)) : t('opening');
}
async function processFile(file) {
  if (!file) return;
  reset(); const current = generation;
  if (!/\.(zip|mcpack|mcaddon)$/i.test(file.name)) { error(message('file_type')); return; }
  if (file.size > 256 * 1024 ** 2) { error(message('file_size')); return; }
  busy = true;
  $('drop-zone').hidden = true; $('processing').hidden = false; $('filename').textContent = `${file.name} · ${size(file.size)}`;
  renderProgress(); announce(message('started', { name: file.name }));
  try {
    const [buffer, fallbackIcon] = await Promise.all([file.arrayBuffer(), fetch(fallbackURL).then(r => { if (!r.ok) throw new Error(); return r.arrayBuffer(); }).then(b => new Uint8Array(b)).catch(() => undefined)]);
    if (current !== generation) return;
    worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    worker.onerror = () => { if (current === generation) error(message('worker_stopped')); };
    worker.onmessage = ({ data }) => {
      if (current !== generation) return;
      if (data.type === 'error') { error(data.message); return; }
      if (data.type === 'result') { showResult(data.result); return; }
      const e = data.event; progressState = e;
      if (e.packs) for (const [i, p] of e.packs.entries()) if (p.icon) { const url = URL.createObjectURL(new Blob([p.icon], { type: 'image/png' })); iconURLs.push(url); packIcons.set(i, url); }
      if (e.stage !== lastStage) { announce(message('stage_' + e.stage)); lastStage = e.stage; }
      const part = e.stage === 'packing' ? 0.85 + (e.percent ?? 0) / 100 * 0.15 : (e.current ?? 0) / Math.max(1, e.total ?? 1) * 0.85;
      progressValue = Math.max(progressValue, e.packCount ? 5 + ((e.packIndex + part) / e.packCount) * 94 : e.stage === 'reading' ? 2 : 5);
      renderProgress();
    };
    worker.postMessage({ buffer, name: file.name, fallbackIcon }, [buffer]);
  } catch { if (current === generation) error(message('file_read')); }
}

$('lang-toggle').addEventListener('click', () => setLang(getLang() === 'zh' ? 'en' : 'zh'));
document.addEventListener('languagechange', () => {
  if (resultState) renderResult();
  if (errorState) $('error').textContent = messageText(errorState);
  if (busy) renderProgress();
  else $('progress').label = t('reading_initial');
  if (announcement) $('announcement').textContent = messageText(announcement);
  else if (resultState) $('announcement').textContent = t(resultState.download ? 'ready' : 'empty') + t('sentence_separator') + resultSummary(resultState);
});
$('choose').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', e => processFile(e.target.files[0]));
$('cancel').addEventListener('click', () => { reset(); announce(message('cancelled')); $('choose').focus(); });
$('again').addEventListener('click', () => { reset(); $('file-input').click(); });
for (const name of ['dragover', 'drop']) window.addEventListener(name, e => e.preventDefault());
$('drop-zone').addEventListener('dragover', () => $('drop-zone').classList.add('drag-over'));
$('drop-zone').addEventListener('dragleave', e => { if (!$('drop-zone').contains(e.relatedTarget)) $('drop-zone').classList.remove('drag-over'); });
$('drop-zone').addEventListener('drop', e => {
  $('drop-zone').classList.remove('drag-over'); if (busy) return;
  if (e.dataTransfer.files.length !== 1) { error(message('single_file')); return; }
  processFile(e.dataTransfer.files[0]);
});
window.addEventListener('pagehide', () => { generation++; worker?.terminate(); disposeURLs(); });
setLang(getLang(), { persist: false });
