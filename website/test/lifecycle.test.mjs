import test from 'node:test';
import assert from 'node:assert/strict';
import { lifecycle, withNameTrigger } from '../src/generator/lifecycle.mjs';
import { script } from './molangeval.mjs';

test('name trigger supplements ordinary death and native pre-death conditions', () => {
  assert.equal(lifecycle.trigger, "!q.is_alive||q.is_name_any('ragdoll')");
  assert.equal(lifecycle.release, "q.is_alive&&!q.is_name_any('ragdoll')");
  const native = withNameTrigger({ trigger: '!q.is_alive||q.swell_amount>=0.9', release: 'q.is_alive&&q.swell_amount<0.9', deathRoll: 90 });
  assert.equal(native.deathRoll, 90);
  for (const named of [0, 1]) for (const alive of [0, 1]) for (const swelling of [0, 1]) {
    const q = { is_name_any: n => { assert.equal(n, 'ragdoll'); return named; }, is_alive: alive, swell_amount: swelling };
    const evaluate = s => !!script('return ' + s + ';')({}, {}, q, {}, {});
    assert.equal(evaluate(lifecycle.trigger), !alive || !!named);
    assert.equal(evaluate(lifecycle.release), !!alive && !named);
    assert.equal(evaluate(native.trigger), !alive || !!named || !!swelling);
    assert.equal(evaluate(native.release), !!alive && !named && !swelling);
  }
});
