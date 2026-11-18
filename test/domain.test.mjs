import test from 'node:test';
import assert from 'node:assert/strict';
import { interpret } from '../src/interpret.mjs';
import { assess, summarize } from '../src/receiving.mjs';
const raw = {"offer": "O100", "query": "Q1", "currency": "CNY", "total": "1250.50", "segments": ["SHA-SIN"], "passengers": ["ADT1"], "expires": "2027-01-01T00:00:00Z"};
const scope = "Q1";

test('领域记录保留明确的来源上下文', () => {
  const actual = interpret(raw);
  assert.equal(actual.query, raw.query);
  assert.equal(assess(actual, [actual], scope).status, 'accepted');
});
test('同一业务依据发生矛盾时不能覆盖接收', () => {
  const first = interpret(raw);
  const changed = interpret({"offer": "O100", "query": "Q1", "currency": "CNY", "total": "99", "segments": ["SHA-SIN"], "passengers": ["ADT1"], "expires": "2027-01-01T00:00:00Z"});
  assert.equal(assess(changed, [first], scope).status, 'conflict');
});
test('空目录与范围外内容不声明完成', () => {
  assert.equal(summarize([]).complete, false);
  const outcome = assess(interpret(raw), [], 'other-scope');
  assert.equal(summarize([outcome]).complete, false);
  assert.equal(summarize([outcome]).counts.outside, 1);
});
test('未知数值不得转为零或可接收记录', () => {
  assert.throws(() => interpret({ ...raw, total: "unknown" }));
  assert.throws(() => interpret({ ...raw, total: "" }));
  assert.throws(() => interpret({ ...raw, total: "NaN" }));
  assert.throws(() => interpret({ ...raw, total: "Infinity" }));
});
