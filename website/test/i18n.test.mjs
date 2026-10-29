import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { detectLang, dictionaries, messageText, STORAGE_KEY, translate } from '../src/i18n.js';
import { errorMessage, GeneratorError, message } from '../src/generator/messages.mjs';
import { RagdollError } from '../vendor/simple-ragdoll/src/i18n.js';
import { validateScript, validateExpression } from '../src/generator/validate.mjs';

test('saved language takes precedence; unsupported values and unavailable storage use browser language', () => {
  const storage = value => ({ getItem(key) { assert.equal(key, STORAGE_KEY); return value; } });
  assert.equal(detectLang(storage('en'), 'zh-CN'), 'en');
  assert.equal(detectLang(storage('zh'), 'en-US'), 'zh');
  assert.equal(detectLang(storage(null), 'zh-TW'), 'zh');
  assert.equal(detectLang(storage('invalid'), 'en-GB'), 'en');
  assert.equal(detectLang({ getItem() { throw Error('blocked'); } }, 'zh-HK'), 'zh');
  assert.equal(detectLang(undefined, 'fr-FR'), 'en');
});

test('UI and generator messages have matching translations and interpolation parameters', async () => {
  assert.deepEqual(Object.keys(dictionaries.zh).sort(), Object.keys(dictionaries.en).sort());
  const slots = text => [...text.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();
  for (const key of Object.keys(dictionaries.en)) assert.deepEqual(slots(dictionaries.zh[key]), slots(dictionaries.en[key]), key);
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  for (const [, key] of html.matchAll(/data-i18n(?:-aria-label)?="([^"]+)"/g)) assert.ok(dictionaries.en[key], key);
  const folder = new URL('../src/generator/', import.meta.url);
  for (const file of await readdir(folder)) if (file.endsWith('.mjs')) {
    const source = await readFile(new URL(file, folder), 'utf8');
    for (const [, code] of source.matchAll(/(?:message|reject|new (?:GeneratorError|InputError))\('([^']+)'/g)) {
      if (code !== 'core_error') assert.ok(dictionaries.en[code], `${file}: ${code}`);
    }
  }
  assert.equal(translate('adapted', { count: 3 }, 'zh'), '已适配的生物（3）');
  assert.equal(translate('adapted', { count: 3 }, 'en'), 'Adapted mobs (3)');
});

test('worker diagnostics preserve nested causes and core parameters for later language switching', () => {
  const cause = errorMessage(new RagdollError('number', ['mass', 0, 10]));
  const wire = structuredClone(errorMessage(new GeneratorError('config_failed', { cause })));
  assert.equal(wire.params.cause.code, 'core_error');
  assert.equal(messageText(wire, 'zh'), '自动配置无法生成：mass 必须为 0 至 10 之间的有限数字。');
  assert.equal(messageText(wire, 'en'), 'Automatic configuration could not be generated: mass must be a finite number between 0 and 10.');
  assert.deepEqual(errorMessage(undefined), message('processing_failed'));
  assert.equal(messageText(errorMessage(Error('Out of memory')), 'en'), 'Generation encountered an error (Out of memory).');
  assert.equal(messageText(message('ambiguous_animation', { id: 'animation.demo' }), 'zh'), '引用了存在歧义的重复动画资源：animation.demo。');
  assert.deepEqual(errorMessage(Error('Missing capture bone head')), message('native_capture_bone', { bone: 'head' }));
  assert.equal(messageText(errorMessage(Error('Expected cat tail1 -> tail2 hierarchy')), 'zh'), '猫尾巴的骨骼连接不符合预期（tail1 → tail2）。');
  assert.throws(() => validateScript('v.test=1;v.test=2'), { code: 'molang_unterminated' });
  assert.throws(() => validateScript('bad=1;'), { code: 'molang_assignment' });
  assert.throws(() => validateExpression('(1+2)??0'), { code: 'molang_coalesce' });
});
