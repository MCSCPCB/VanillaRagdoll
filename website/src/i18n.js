import { messages } from './messages.js';
import coreEN from '../vendor/simple-ragdoll/lang/en.json' with { type: 'json' };
import coreZH from '../vendor/simple-ragdoll/lang/zh.json' with { type: 'json' };

export const STORAGE_KEY = 'vanillaragdoll.lang';
export const dictionaries = {
  zh: {
    ...messages.zh,
    title: '布娃娃补丁生成器 · VanillaRagdoll',
    description: '为 Minecraft 基岩版 Add-on 生成布娃娃补丁。支持 .zip、.mcpack 和 .mcaddon，文件只在浏览器本地处理。',
    home: 'VanillaRagdoll 首页', heading: '布娃娃补丁生成器', subtitle: '为 Add-on 中的生物添加死亡布娃娃',
    card_title: '添加你的资源包', drop_title: '把文件拖到这里', extensions: '支持 .zip、.mcpack、.mcaddon',
    choose: '选择文件', choose_label: '选择资源包或 Add-on 文件', file_limit: '单个文件最大 256 MB',
    processing: '正在处理', cancel: '取消处理', ready: '补丁已生成', download: '下载布娃娃补丁', again: '处理另一个包',
    install: '导入后，同时启用原包与补丁，并将补丁放在原包上方。', details: '处理详情',
    privacy: '文件仅在你的浏览器内处理，不会上传到服务器', guide_title: '从资源包到布娃娃',
    step1_title: '选择原包', step1: '上传资源包，或包含资源包的 Add-on。',
    step2_title: '自动生成', step2: '自动识别可适配的生物并生成补丁。',
    step3_title: '下载并启用补丁', step3: '同时启用原包与补丁，并将补丁放在原包上方。',
    notes_title: '使用须知', version_before: '需要基岩版 1.26.50 或更高版本。如需为原版生物添加布娃娃，请使用 ', version_after: '。',
    compatibility: '带有特殊死亡动画或复杂模型的生物可能无法适配，这类生物会被跳过，并在“处理详情”中说明原因。',
    name_before: '用命名牌把生物命名为 ', name_after: '，它会立即变成布娃娃。改成其他名字即可恢复。',
    based_before: '基于 ', ui_before: '界面使用 ', notices: '开源声明',
    unofficial: '非 Minecraft 官方产品，未经 Mojang 或 Microsoft 批准，也与其无关',
    noscript: '需要启用 JavaScript 才能生成布娃娃补丁。',
    progress_label: '生成进度', reading_initial: '正在读取', opening: '正在打开文件',
    stage_reading: '读取资源包', stage_inspecting: '检查生物', stage_generating: '生成布娃娃', stage_packing: '打包补丁',
    progress_reading: '正在读取 {name}', progress_inspecting: '检查模型与动画引用', progress_complete: '生物处理完成',
    progress_packing: '正在打包 {name}', progress_mob: '{name}',
    empty: '没有可适配的生物', summary: '已适配 {count} 个生物', skipped: ' · 跳过 {count} 个',
    download_size: '下载补丁 · {size}', pack_summary: '{count} 个生物 · {file}',
    adapted: '已适配的生物（{count}）', report_skips: '查看处理详情与跳过原因', report_success: '查看已适配的生物',
    summary_one: '已适配 {count} 个生物', pack_summary_one: '{count} 个生物 · {file}', adapted_one: '已适配的生物（{count}）',
    issue: '{name}：{reason}', list_separator: '、', sentence_separator: '。', started: '开始处理 {name}', cancelled: '已取消处理',
  },
  en: {
    ...messages.en,
    title: 'Ragdoll Patch Generator · VanillaRagdoll',
    description: 'Generate ragdoll patches for Minecraft Bedrock Add-ons. Supports .zip, .mcpack and .mcaddon. Files are processed only in your browser.',
    home: 'VanillaRagdoll home', heading: 'Ragdoll Patch Generator', subtitle: 'Add death ragdolls to mobs in your add-ons',
    card_title: 'Add your resource pack', drop_title: 'Drop a file here', extensions: 'Supports .zip, .mcpack and .mcaddon',
    choose: 'Choose file', choose_label: 'Choose a resource pack or Add-on file', file_limit: 'Up to 256 MB per file',
    processing: 'Processing', cancel: 'Cancel', ready: 'Patch ready', download: 'Download ragdoll patch', again: 'Process another pack',
    install: 'Enable both the original pack and the patch, with the patch above the original.', details: 'Details',
    privacy: 'Files are processed in your browser and never uploaded', guide_title: 'From resource pack to ragdoll',
    step1_title: 'Choose the original pack', step1: 'Upload a resource pack, or an add-on that contains one.',
    step2_title: 'Generate automatically', step2: 'Compatible mobs are detected and a patch is generated.',
    step3_title: 'Download and enable the patch', step3: 'Enable both the original pack and the patch, with the patch above the original.',
    notes_title: 'Before you start', version_before: 'Requires Bedrock 1.26.50 or later. For vanilla mobs, use ', version_after: '.',
    compatibility: 'Mobs with custom death animations or complex models may not be supported. They are skipped, and the reason is shown in Details.',
    name_before: 'Name a mob ', name_after: ' with a name tag to turn it into a ragdoll right away. Rename it to restore it.',
    based_before: 'Built on ', ui_before: 'UI by ', notices: 'Open source notices',
    unofficial: 'NOT AN OFFICIAL MINECRAFT PRODUCT. NOT APPROVED BY OR ASSOCIATED WITH MOJANG OR MICROSOFT.',
    noscript: 'JavaScript is required to generate ragdoll patches.',
    progress_label: 'Generation progress', reading_initial: 'Reading', opening: 'Opening file',
    stage_reading: 'Reading resource pack', stage_inspecting: 'Checking mobs', stage_generating: 'Generating ragdolls', stage_packing: 'Packing patch',
    progress_reading: 'Reading {name}', progress_inspecting: 'Checking model and animation references', progress_complete: 'Mob processing complete',
    progress_packing: 'Packing {name}', progress_mob: '{name}',
    empty: 'No compatible mobs', summary: 'Adapted {count} mobs', skipped: ' · Skipped {count}',
    download_size: 'Download patch · {size}', pack_summary: '{count} mobs · {file}',
    adapted: 'Adapted mobs ({count})', report_skips: 'View details and skip reasons', report_success: 'View adapted mobs',
    summary_one: 'Adapted {count} mob', pack_summary_one: '{count} mob · {file}', adapted_one: 'Adapted mob ({count})',
    issue: '{name}: {reason}', list_separator: ', ', sentence_separator: '. ', started: 'Processing {name}', cancelled: 'Processing cancelled',
  },
};

export function detectLang(storage, language) {
  try { const saved = storage?.getItem(STORAGE_KEY); if (saved === 'zh' || saved === 'en') return saved; } catch { /* Storage may be disabled. */ }
  return /^zh/i.test(language ?? '') ? 'zh' : 'en';
}
let current;
export function getLang() {
  if (!current) {
    let storage; try { storage = globalThis.localStorage; } catch { /* Private browsing. */ }
    current = detectLang(storage, globalThis.navigator?.language);
  }
  return current;
}
const interpolate = (text, params) => text.replace(/\{(\w+)\}/g, (_, key) => String(params[key] ?? ''));
export function translate(key, params = {}, lang = getLang()) {
  if (params.count === 1 && dictionaries[lang]?.[key + '_one']) key += '_one';
  return interpolate(dictionaries[lang]?.[key] ?? dictionaries.en[key] ?? key, params);
}
export const t = (key, params) => translate(key, params);
const endSentence = (text, lang) => text.replace(/[。.!\s]+$/, '') + (lang === 'zh' ? '。' : '.');
export function messageText(value, lang = getLang()) {
  if (!value || typeof value.code !== 'string') return translate('processing_failed', {}, lang);
  const params = { ...value.params };
  if (value.code === 'core_error') {
    const table = lang === 'zh' ? coreZH : coreEN, key = 'ragdoll.error.' + params.key;
    const template = table[key] ?? coreEN[key];
    if (!template) return translate('unexpected', { detail: params.key }, lang);
    let text = template.replace(/%(\d+)/g, (_, i) => String(params.values?.[i] ?? ''));
    if (lang === 'zh') text = text.replace(/实体/g, '生物').replace(/；/g, '。').replace(/\(/g, '（').replace(/\)/g, '）');
    return endSentence(text, lang);
  }
  if (params.cause) params.cause = messageText(params.cause, lang).replace(/[。.]+$/, '');
  return translate(value.code, params, lang);
}

export function setLang(lang, { persist = true } = {}) {
  if (lang !== 'zh' && lang !== 'en') return;
  current = lang;
  if (persist) try { globalThis.localStorage?.setItem(STORAGE_KEY, lang); } catch { /* Session-only selection still works. */ }
  if (typeof document === 'undefined') return;
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  document.title = t('title');
  document.querySelector('meta[name="description"]')?.setAttribute('content', t('description'));
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of document.querySelectorAll('[data-i18n-aria-label]')) el.setAttribute('aria-label', t(el.dataset.i18nAriaLabel));
  const button = document.getElementById('lang-toggle');
  if (button) {
    button.textContent = lang === 'zh' ? 'EN' : '中文';
    button.lang = lang === 'zh' ? 'en' : 'zh-CN';
    button.setAttribute('aria-label', lang === 'zh' ? 'Switch to English' : '切换为中文');
  }
  document.dispatchEvent(new Event('languagechange'));
}
