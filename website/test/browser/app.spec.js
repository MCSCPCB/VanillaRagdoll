import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import JSZip from 'jszip';
import { pack, client, vanillaClient } from '../fixtures.mjs';

test('production page: worker, local-only processing, exact download contents and repeat upload', async ({ page }, info) => {
  const errors = [], external = [], bad = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', e => { if (e.type() === 'error') errors.push(e.text()); });
  page.on('request', r => { if (/^https?:/.test(r.url()) && !r.url().startsWith('http://127.0.0.1:4173/')) external.push(r.url()); });
  page.on('response', r => { if (r.status() >= 400) bad.push(r.url()); });
  await page.goto('./');
  await expect(page.getByRole('heading', { name: '布娃娃补丁生成器', exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('desktop.png'), fullPage: true });
  const bytes = await pack();
  await page.locator('#file-input').setInputFiles({ name: 'creatures.mcpack', mimeType: 'application/zip', buffer: Buffer.from(bytes) });
  await expect(page.getByRole('heading', { name: '补丁已生成' })).toBeVisible({ timeout: 30000 });
  await expect(page.locator('#pack-list')).toContainText('Test Creatures Ragdoll');
  const waiting = page.waitForEvent('download'); await page.locator('#download').click(); const download = await waiting;
  expect(download.suggestedFilename()).toBe('Test Creatures Ragdoll.mcpack');
  const zip = await JSZip.loadAsync(await readFile(await download.path()));
  const gates = Object.keys(zip.files).filter(p => /animations\/.*_gate\.json$/.test(p));
  expect(gates).toHaveLength(1);
  const gateId = Object.keys(JSON.parse(await zip.file(gates[0]).async('string')).animations)[0];
  const c = JSON.parse(await zip.file('entity/demo0.entity.json').async('string'))['minecraft:client_entity'].description;
  expect(c.animations[Object.keys(c.scripts.animate[0])[0]]).toBe(gateId);
  const manifest = JSON.parse(await zip.file('manifest.json').async('string'));
  expect(manifest.header.name).toBe('Test Creatures Ragdoll'); expect(manifest.header.description).toBe('Simple Ragdoll');
  expect(manifest.format_version).toBe(3); expect(manifest.subpacks).toBeUndefined();
  const [setting] = manifest.settings;
  expect(setting.type).toBe('dropdown'); expect(setting.default).toBe('ragdoll');
  expect(setting.options.map(o => o.name)).toEqual(['ragdoll', 'blocky']);
  const modeFile = Object.keys(zip.files).find(p => /^animations\/.*_mode\.json$/.test(p));
  const mode = JSON.parse(await zip.file(modeFile).async('string'));
  expect(Object.values(mode.animations)[0].anim_time_update).toContain(`q.is_pack_setting_selected('${setting.name}','blocky')`);
  expect(await zip.file('texts/en_US.lang').async('string')).toContain('Blocky §7Splits each mob in its individual parts.');
  expect(await zip.file('texts/zh_CN.lang').async('string')).toContain('布娃娃 §7将生物变成布娃娃');
  expect(zip.file('pack_icon.png')).toBeTruthy(); expect(zip.file('models/entity/demo.geo.json')).toBeNull();
  await page.screenshot({ path: info.outputPath('result.png'), fullPage: true });
  await page.locator('#again').click();
  await page.locator('#file-input').setInputFiles({ name: 'creatures.mcpack', mimeType: 'application/zip', buffer: Buffer.from(bytes) });
  await expect(page.getByRole('heading', { name: '补丁已生成' })).toBeVisible({ timeout: 30000 });
  expect(errors).toEqual([]); expect(external).toEqual([]); expect(bad).toEqual([]);
});

test('vanilla references compile in the production worker without uploading vanilla models', async ({ page }) => {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('./');
  const bytes = await pack({ clients: [vanillaClient(), vanillaClient('witch'), vanillaClient('evoker')] });
  await page.locator('#file-input').setInputFiles({ name: 'vanilla-references.mcpack', mimeType: 'application/zip', buffer: Buffer.from(bytes) });
  // This fixture compiles five physics profiles; shared CI runners can exceed
  // Playwright's default five-second assertion timeout without a product fault.
  await expect(page.getByRole('heading', { name: '补丁已生成' })).toBeVisible({ timeout: 45000 });
  const waiting = page.waitForEvent('download'); await page.locator('#download').click(); const download = await waiting;
  const zip = await JSZip.loadAsync(await readFile(await download.path()));
  for (let i = 0; i < 3; i++) expect(zip.file(`entity/demo${i}.entity.json`)).toBeTruthy();
  expect(Object.keys(zip.files).some(p => p.startsWith('models/'))).toBe(false);
  expect(Object.keys(zip.files).some(p => p.startsWith('render_controllers/'))).toBe(true);
  expect(errors).toEqual([]);
});

test('mobile: error recovery, cancellation, keyboard access and narrow layout', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto('./');
  await page.screenshot({ path: info.outputPath('mobile.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('#choose').focus();
  const chooser = page.waitForEvent('filechooser'); await page.keyboard.press('Enter'); await chooser;
  await page.locator('#file-input').setInputFiles({ name: 'broken.zip', mimeType: 'application/zip', buffer: Buffer.from('broken') });
  await expect(page.getByRole('alert')).toContainText('无法读取压缩包');
  const bytes = await pack();
  await page.locator('#file-input').setInputFiles({ name: 'creatures.mcpack', mimeType: 'application/zip', buffer: Buffer.from(bytes) });
  await page.locator('#cancel').click();
  await expect(page.locator('#drop-zone')).toBeVisible(); await expect(page.locator('#result')).toBeHidden();
  await page.locator('#file-input').setInputFiles({ name: 'creatures.mcpack', mimeType: 'application/zip', buffer: Buffer.from(bytes) });
  await expect(page.getByRole('heading', { name: '补丁已生成' })).toBeVisible({ timeout: 30000 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('language switch updates metadata and persists across reloads', async ({ page }) => {
  await page.goto('./');
  await page.getByRole('button', { name: 'Switch to English' }).click();
  await expect(page.locator('h1')).toHaveText('Ragdoll Patch Generator');
  await expect(page).toHaveTitle('Ragdoll Patch Generator · VanillaRagdoll');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('meta[name="description"]')).toHaveAttribute('content', /Generate ragdoll patches/);
  await expect(page.locator('#file-input')).toHaveAttribute('aria-label', 'Choose a resource pack or Add-on file');
  await expect(page.locator('#lang-toggle')).toHaveText('中文');
  await page.reload();
  await expect(page.locator('h1')).toHaveText('Ragdoll Patch Generator');
  await page.getByRole('button', { name: '切换为中文' }).click();
  await page.reload();
  await expect(page.locator('h1')).toHaveText('布娃娃补丁生成器');
});

test.describe('English browser preference', () => {
  test.use({ locale: 'en-US' });
  test('starts in English without writing a preference until explicitly selected', async ({ page }) => {
    await page.goto('./');
    await expect(page.locator('h1')).toHaveText('Ragdoll Patch Generator');
    expect(await page.evaluate(() => localStorage.getItem('vanillaragdoll.lang'))).toBeNull();
    await page.getByRole('button', { name: '切换为中文' }).click();
    await page.reload();
    await expect(page.locator('h1')).toHaveText('布娃娃补丁生成器');
  });
});

test('existing input and worker errors, progress, results and skip reasons switch language without regeneration', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('./');
  await page.locator('#file-input').setInputFiles({ name: 'bad.txt', mimeType: 'text/plain', buffer: Buffer.from('bad') });
  await expect(page.getByRole('alert')).toHaveText('请选择 .zip、.mcpack 或 .mcaddon 文件。');
  await page.locator('#lang-toggle').click();
  await expect(page.getByRole('alert')).toHaveText('Please choose a .zip, .mcpack or .mcaddon file.');
  await page.locator('#file-input').setInputFiles({ name: 'broken.zip', mimeType: 'application/zip', buffer: Buffer.from('bad') });
  await expect(page.getByRole('alert')).toContainText('Cannot read the archive.');
  await page.locator('#lang-toggle').click();
  await expect(page.getByRole('alert')).toContainText('无法读取压缩包');

  const missing = client('demo:missing'); missing['minecraft:client_entity'].description.geometry.default = 'geometry.missing';
  await page.locator('#file-input').setInputFiles({ name: 'mixed.mcpack', mimeType: 'application/zip', buffer: Buffer.from(await pack({ clients: [client(), missing] })) });
  await expect(page.locator('#processing')).toBeVisible();
  await page.locator('#lang-toggle').click();
  await expect(page.locator('#processing-title')).toHaveText('Processing');
  await expect(page.locator('#progress')).toHaveAttribute('aria-label', 'Generation progress');
  await expect(page.getByRole('heading', { name: 'Patch ready' })).toBeVisible({ timeout: 30000 });
  await expect(page.locator('#result-summary')).toHaveText('Adapted 1 mob · Skipped 1');
  const url = await page.locator('#download').evaluate(el => el.href);
  await page.locator('#report-title').click();
  await expect(page.locator('#report-content')).toContainText('The mob model is missing.');
  await page.locator('#report-content summary').click();
  await page.locator('#lang-toggle').click();
  await expect(page.locator('#result-summary')).toHaveText('已适配 1 个生物 · 跳过 1 个');
  await expect(page.locator('#report-content')).toContainText('缺少生物模型。');
  await expect(page.locator('#report-content summary')).toHaveText('已适配的生物（1）');
  expect(await page.locator('#report-content details').evaluate(el => el.open)).toBe(true);
  expect(await page.locator('#download').evaluate(el => el.href)).toBe(url);
  const waiting = page.waitForEvent('download'); await page.locator('#download').click();
  expect((await waiting).suggestedFilename()).toBe('Test Creatures Ragdoll.mcpack');
  await page.locator('#lang-toggle').click();
  await expect(page.locator('#report-content')).toContainText('The mob model is missing.');
  expect(errors).toEqual([]);
});

test('no-compatible result is translated and never exposes a download', async ({ page }) => {
  await page.goto('./');
  await page.locator('#file-input').setInputFiles({ name: 'vanilla.mcpack', mimeType: 'application/zip', buffer: Buffer.from(await pack({ clients: [client('minecraft:zombie')] })) });
  await expect(page.locator('#result-title')).toHaveText('没有可适配的生物');
  await expect(page.locator('#download')).toBeHidden();
  await page.locator('#lang-toggle').click();
  await expect(page.locator('#result-title')).toHaveText('No compatible mobs');
  await expect(page.locator('#report-content')).toContainText('Vanilla mobs are handled by VanillaRagdoll.');
  await expect(page.locator('#download')).toBeHidden();
});

test('both languages fit desktop, tablet and mobile layouts', async ({ page }, info) => {
  await page.goto('./');
  for (const width of [1280, 800, 440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const lang of ['zh', 'en']) {
      if ((await page.locator('html').getAttribute('lang')).startsWith('zh') !== (lang === 'zh')) await page.locator('#lang-toggle').click();
      await expect(page.locator('h1')).toHaveText(lang === 'zh' ? '布娃娃补丁生成器' : 'Ragdoll Patch Generator');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const brand = await page.locator('.brand').boundingBox(), actions = await page.locator('.topbar-actions').boundingBox();
      expect(brand.x + brand.width).toBeLessThan(actions.x);
      expect(actions.x + actions.width).toBeLessThanOrEqual(width);
      await page.screenshot({ path: info.outputPath(`${width}-${lang}.png`), fullPage: true });
    }
  }
});
