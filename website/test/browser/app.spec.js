import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import JSZip from 'jszip';
import { pack, vanillaClient } from '../fixtures.mjs';

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
  await expect(page.getByRole('heading', { name: '补丁已生成' })).toBeVisible();
  await expect(page.locator('#pack-list')).toContainText('Test Creatures Ragdoll');
  const waiting = page.waitForEvent('download'); await page.locator('#download').click(); const download = await waiting;
  expect(download.suggestedFilename()).toBe('Test Creatures Ragdoll.mcpack');
  const zip = await JSZip.loadAsync(await readFile(await download.path()));
  const manifest = JSON.parse(await zip.file('manifest.json').async('string'));
  expect(manifest.header.name).toBe('Test Creatures Ragdoll'); expect(manifest.header.description).toBe('Simple Ragdoll');
  expect(zip.file('pack_icon.png')).toBeTruthy(); expect(zip.file('models/entity/demo.geo.json')).toBeNull();
  await page.screenshot({ path: info.outputPath('result.png'), fullPage: true });
  await page.locator('#again').click();
  await page.locator('#file-input').setInputFiles({ name: 'creatures.mcpack', mimeType: 'application/zip', buffer: Buffer.from(bytes) });
  await expect(page.getByRole('heading', { name: '补丁已生成' })).toBeVisible();
  expect(errors).toEqual([]); expect(external).toEqual([]); expect(bad).toEqual([]);
});

test('vanilla references compile in the production worker without uploading vanilla models', async ({ page }) => {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('./');
  const bytes = await pack({ clients: [vanillaClient(), vanillaClient('witch'), vanillaClient('evoker')] });
  await page.locator('#file-input').setInputFiles({ name: 'vanilla-references.mcpack', mimeType: 'application/zip', buffer: Buffer.from(bytes) });
  await expect(page.getByRole('heading', { name: '补丁已生成' })).toBeVisible();
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
  await expect(page.getByRole('heading', { name: '补丁已生成' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
