import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SourceClient } from '../src/http.mjs';
import { fixtureSource } from '../src/fixture-source.mjs';
import { Archive } from '../src/archive.mjs';
import { interpret, interpretInquiry, interpretRelations, interpretService, SERVICE_TYPES } from '../src/interpret.mjs';
import { assessScope, assessReissue, evaluateOfferPackage } from '../src/receiving.mjs';
import { collectServices } from '../src/app.mjs';

const packageFixture = JSON.parse(await readFile(new URL('../fixtures/service-package.json', import.meta.url), 'utf8'));
const mainFixture = JSON.parse(await readFile(new URL('../fixtures/source.json', import.meta.url), 'utf8'));
const NOW = new Date('2026-11-19T00:00:00Z');

async function withEnvironment(fixture, body) {
  const source = await fixtureSource(fixture);
  const directory = await mkdtemp(join(tmpdir(), 'package-'));
  const archive = await new Archive(directory).start();
  try {
    await body(source, archive, directory);
  } finally {
    archive.close();
    await source.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function resultFor(result, offer) {
  return result.packages.find(item => item.offer === offer);
}

test('完整资料包逐项齐备并带原文追溯', async () => {
  await withEnvironment(packageFixture, async (source, archive) => {
    const result = await collectServices(new SourceClient(source.url), archive, 'Q9', { now: NOW });
    const o203 = resultFor(result, 'O203');
    assert.equal(o203.status, 'complete');
    for (const type of SERVICE_TYPES) {
      const items = o203.items.filter(item => item.type === type);
      assert.ok(items.length >= 1);
      assert.ok(items.every(item => item.state === 'complete' && /^[a-f0-9]{64}$/.test(item.digest)));
    }
    assert.ok(o203.trace.relationsDigest);
    assert.equal(o203.trace.evidence.length, 3);
  });
});

test('成人去程行李不扩给婴儿与回程，缺项逐项报 missing', async () => {
  await withEnvironment(packageFixture, async (source, archive) => {
    const result = await collectServices(new SourceClient(source.url), archive, 'Q9', { now: NOW });
    assert.equal(result.complete, false);
    const o200 = resultFor(result, 'O200');
    assert.equal(o200.status, 'missing');
    const baggage = o200.items.find(item => item.id === 'B1');
    assert.equal(baggage.state, 'complete');
    assert.deepEqual(baggage.passengers, ['ADT1']);
    assert.deepEqual(baggage.segments, ['SHA-SIN']);
    const missingCells = o200.items.filter(item => item.type === 'baggage' && item.state === 'missing').map(item => item.reason);
    assert.ok(missingCells.includes('报价范围内缺少旅客×航段说明：ADT1@SIN-SHA'));
    assert.ok(missingCells.includes('报价范围内缺少旅客×航段说明：INF1@SHA-SIN'));
    assert.ok(missingCells.includes('报价范围内缺少旅客×航段说明：INF1@SIN-SHA'));
  });
});

test('资料齐备但全部过期时整体报 expired 且保留历史依据', async () => {
  await withEnvironment(packageFixture, async (source, archive) => {
    const result = await collectServices(new SourceClient(source.url), archive, 'Q9', { now: NOW });
    const o201 = resultFor(result, 'O201');
    assert.equal(o201.status, 'expired');
    assert.ok(o201.items.every(item => item.state === 'expired'));
    const rows = archive.records('Q9').filter(row => row.business_key.includes('O201'));
    assert.ok(rows.some(row => row.record.offer === 'O201' && row.record.total === 2100));
  });
});

test('报价内部引用互相冲突时报 conflict 且不覆盖任一原文', async () => {
  await withEnvironment(packageFixture, async (source, archive) => {
    const result = await collectServices(new SourceClient(source.url), archive, 'Q9', { now: NOW });
    const o202 = resultFor(result, 'O202');
    assert.equal(o202.status, 'conflict');
    const conflict = o202.items.find(item => item.id === 'B3' && item.state === 'conflict');
    assert.match(conflict.reason, /冲突/);
    assert.equal(o202.trace.evidence.some(entry => entry.service === 'B3'), false);
    assert.ok(o202.trace.references.some(entry => entry.id === 'B3'));
  });
});

test('服务说明适用范围与引用冲突时按 conflict 处理', async () => {
  const inquiry = { query: 'Q9', currency: 'CNY', passengers: ['ADT1', 'INF1'], segments: ['SHA-SIN', 'SIN-SHA'] };
  const offer = { offer: 'OX', query: 'Q9', passengers: inquiry.passengers, segments: inquiry.segments };
  const reference = { id: 'B9', type: 'baggage', passengers: ['ADT1', 'INF1'], segments: ['SHA-SIN', 'SIN-SHA'], ref: '/shopping/Q9/services/B9' };
  assert.throws(
    () => interpretService({ query: 'Q9', service: 'B9', type: 'baggage', passengers: ['ADT1'], segments: ['SHA-SIN'], expires: '2027-01-01T00:00:00Z' }, reference, offer),
    /冲突/
  );
  const statements = new Map();
  const pkg = evaluateOfferPackage(
    offer, [reference], statements,
    [{ key: 'baggage:B9', id: 'B9', type: 'baggage', reason: '服务说明适用旅客或航段与引用冲突：B9' }],
    [], NOW
  );
  assert.equal(pkg.status, 'conflict');
});

test('同一编号在另一次询价中不能复用：query 不符直接拒绝', () => {
  const offer = { offer: 'O100', query: 'Q1', passengers: ['ADT1'], segments: ['SHA-SIN'] };
  const reference = { id: 'S1', type: 'baggage', passengers: ['ADT1'], segments: ['SHA-SIN'], ref: '/shopping/Q1/services/S1' };
  assert.throws(
    () => interpretService({ query: 'OTHER', service: 'S1', type: 'baggage', passengers: ['ADT1'], segments: ['SHA-SIN'], expires: '2027-01-01T00:00:00Z' }, reference, offer),
    /另一次询价/
  );
});

test('部分航段重报是独立报价，原报价总价与原文保留且不并入新税费', async () => {
  await withEnvironment(packageFixture, async (source, archive) => {
    const result = await collectServices(new SourceClient(source.url), archive, 'Q9', { now: NOW });
    const o201 = resultFor(result, 'O201');
    const o203 = resultFor(result, 'O203');
    assert.equal(o201.status, 'expired');
    assert.equal(o203.status, 'complete');
    assert.match(o203.note, /另一份报价/);
    assert.deepEqual(o203.reissues, ['O201']);
    assert.equal(result.outcomes.find(item => item.reference === 'O203').status, 'accepted');
    const rows = archive.records('Q9');
    const original = rows.find(row => row.record.offer === 'O201');
    const reissue = rows.find(row => row.record.offer === 'O203');
    assert.equal(original.record.total, 2100);
    assert.equal(reissue.record.total, 900);
    assert.notEqual(original.digest, reissue.digest);
    const originalBytes = JSON.parse((await archive.original(original.digest)).toString());
    assert.equal(originalBytes.total, '2100.00');
  });
});

test('非局部航段或缺少原报价的重报声明被拒绝', () => {
  const inquiry = { query: 'Q9', currency: 'CNY', passengers: ['ADT1', 'INF1'], segments: ['SHA-SIN', 'SIN-SHA'] };
  const predecessor = { offer: 'O201', query: 'Q9', passengers: ['ADT1', 'INF1'], segments: ['SHA-SIN', 'SIN-SHA'] };
  const good = { offer: 'O298', query: 'Q9', currency: 'CNY', passengers: ['ADT1'], segments: ['SHA-SIN'], reissues: [{ offer: 'O201', passengers: ['ADT1'], segments: ['SHA-SIN'] }] };
  assert.equal(assessReissue(good, [predecessor], inquiry).status, 'accepted');
  const unknown = { ...good, offer: 'O297', reissues: [{ offer: 'O404', passengers: ['ADT1'], segments: ['SHA-SIN'] }] };
  assert.equal(assessReissue(unknown, [predecessor], inquiry).status, 'conflict');
  const wide = { ...good, offer: 'O296', reissues: [{ offer: 'O201', passengers: ['ADT1', 'INF1'], segments: ['SHA-SIN', 'SIN-SHA'] }] };
  assert.equal(assessReissue(wide, [predecessor], inquiry).status, 'conflict');
});

test('币种不符的报价按范围外处理且不进入资料包完成判定', async () => {
  await withEnvironment(packageFixture, async (source, archive) => {
    const result = await collectServices(new SourceClient(source.url), archive, 'Q9', { now: NOW });
    const outcome = result.outcomes.find(item => item.reference === 'O204');
    assert.equal(outcome.status, 'outside');
    assert.match(outcome.reason, /币种/);
    assert.equal(resultFor(result, 'O204'), undefined);
  });
});

test('来源 404 与 403 如实记为取不到，不臆造业务删除', async () => {
  await withEnvironment(packageFixture, async (source, archive) => {
    source.replace('/shopping/Q9/relations/O203', { status: 404, body: { error: '暂未发布' } });
    const notFound = await collectServices(new SourceClient(source.url), archive, 'Q9', { now: NOW });
    const o203 = resultFor(notFound, 'O203');
    assert.equal(o203.status, 'missing');
    assert.match(o203.failures[0].reason, /404/);
  });
  await withEnvironment(packageFixture, async (source, archive) => {
    source.replace('/shopping/Q9/services/B4', { status: 403, body: { error: '无权领取' } });
    const forbidden = await collectServices(new SourceClient(source.url), archive, 'Q9', { now: NOW });
    const item = resultFor(forbidden, 'O203').items.find(entry => entry.id === 'B4');
    assert.equal(item.state, 'missing');
    assert.match(item.reason, /403/);
  });
});

test('主夹具的既有报价预览与常规收件行为保持不变', async () => {
  await withEnvironment(mainFixture, async (source, archive) => {
    const client = new SourceClient(source.url);
    const result = await collectServices(client, archive, 'Q1', { now: NOW });
    assert.equal(result.context, 'Q1');
    assert.equal(result.complete, true);
    const pkg = resultFor(result, 'O100');
    assert.equal(pkg.status, 'complete');
    assert.deepEqual(result.inquiry, { query: 'Q1', currency: 'CNY', passengers: ['ADT1'], segments: ['SHA-SIN'] });
    assert.equal(archive.records('Q1').length, 5);
  });
});

test('跨询价同编号同金额的服务说明不能复用，且重复采集不新增收据', async () => {
  await withEnvironment(packageFixture, async (source, archive) => {
    const client = new SourceClient(source.url);
    const first = await collectServices(client, archive, 'Q9', { now: NOW });
    const countAfterFirst = archive.records('Q9').length;
    const second = await collectServices(client, archive, 'Q9', { now: NOW });
    assert.equal(archive.records('Q9').length, countAfterFirst);
    assert.deepEqual(second.counts, first.counts);

    source.replace('/shopping/Q9/services/B4', {
      body: { query: 'Q1', service: 'B4', type: 'baggage', passengers: ['ADT1'], segments: ['SHA-SIN'], expires: '2027-03-01T00:00:00Z', amount: '0.00' },
    });
    const poisoned = await collectServices(client, archive, 'Q9', { now: NOW });
    const item = resultFor(poisoned, 'O203').items.find(entry => entry.id === 'B4');
    assert.equal(item.state, 'conflict');
    assert.match(item.reason, /另一次询价/);
    const evidence = resultFor(poisoned, 'O203').trace.evidence;
    assert.equal(evidence.some(entry => entry.service === 'B4'), false);
  });
});

test('询价目录范围声明与来源校验', () => {
  const inquiry = interpretInquiry({ query: 'Q9', currency: 'CNY', passengers: ['ADT1', 'INF1'], segments: ['SHA-SIN', 'SIN-SHA'] });
  assert.equal(inquiry.passengers.length, 2);
  assert.throws(() => interpretInquiry({ query: 'Q9', currency: 'CN', passengers: ['ADT1'], segments: ['SHA-SIN'] }), /币种/);
  const offer = { offer: 'O1', query: 'Q9', currency: 'CNY', passengers: ['ADT1'], segments: ['SHA-SIN'] };
  assert.equal(assessScope(offer, inquiry).ok, true);
  assert.equal(assessScope({ ...offer, passengers: ['HACK'] }, inquiry).ok, false);
  assert.throws(
    () => interpretRelations({ query: 'Q8', offer: 'O1', services: [] }, offer, { prefix: '/shopping/Q9' }),
    /不符/
  );
  assert.throws(
    () => interpretRelations({ query: 'Q9', offer: 'O1', services: [{ id: 'X', type: 'baggage', passengers: ['ADT1'], segments: ['SHA-SIN'], ref: '/shopping/Q8/services/X' }] }, offer, { prefix: '/shopping/Q9' }),
    /越过询价上下文/
  );
});
