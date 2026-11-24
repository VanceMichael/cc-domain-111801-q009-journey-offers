import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SourceClient } from '../src/http.mjs';
import { fixtureSource } from '../src/fixture-source.mjs';
import { Archive } from '../src/archive.mjs';
import { collect, preview } from '../src/app.mjs';
import { interpret, interpretInquiry, interpretRelations, interpretStatement } from '../src/interpret.mjs';
import { buildDossier, SERVICE_KINDS } from '../src/dossier.mjs';
import { assess } from '../src/receiving.mjs';

const baseFixture = JSON.parse(await readFile(new URL('../fixtures/source.json', import.meta.url), 'utf8'));
const scope = 'Q1';
const NOW = Date.parse('2026-11-24T00:00:00Z');

async function runCollect(fixture) {
  const source = await fixtureSource(fixture);
  const directory = await mkdtemp(join(tmpdir(), 'dossier-'));
  const archive = await new Archive(directory).start();
  let result;
  try {
    result = await collect(new SourceClient(source.url), archive, scope);
    return { result, archive, source, directory };
  } catch (error) {
    archive.close(); await source.close(); await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
async function cleanup(handle) { handle.archive.close(); await handle.source.close(); await rm(handle.directory, { recursive: true, force: true }); }
function makeStatement(id, kind, description, { amount = '0.00', expires = '2027-01-01T00:00:00Z', query = 'Q1', currency = 'CNY' } = {}) {
  return { id, query, kind, description, amount, currency, expires };
}
function makeEntry(id, kind, passengers, segments, { query = 'Q1', href } = {}) {
  return { id, kind, passengers, segments, ref: href ?? `/shopping/${query}/services/${id}` };
}
const inquiry = interpretInquiry({ query: 'Q1', currency: 'CNY', passengers: ['ADT1', 'INF1'], segments: ['SHA-SIN', 'SIN-SHA'] });
const fullRelations = (overrides = {}) => interpretRelations({
  query: 'Q1', offer: 'O100',
  services: [
    makeEntry('B1', 'baggage', ['ADT1', 'INF1'], ['SHA-SIN', 'SIN-SHA']),
    makeEntry('C1', 'change', ['ADT1', 'INF1'], ['SHA-SIN', 'SIN-SHA']),
    makeEntry('A1', 'ancillary', ['ADT1', 'INF1'], ['SHA-SIN', 'SIN-SHA']),
  ], ...overrides,
});
function statementMap(entries, mutator = () => ({})) {
  const map = new Map();
  for (const entry of entries) {
    map.set(entry.id, { digest: 'd-' + entry.id, record: interpretStatement(makeStatement(entry.id, entry.kind, '说明-' + entry.id, mutator(entry.id))) });
  }
  return map;
}
const fullOffer = { offer: 'O100', query: 'Q1', currency: 'CNY', total: 1250.5, passengers: ['ADT1', 'INF1'], segments: ['SHA-SIN', 'SIN-SHA'], expires: '2027-01-01T00:00:00Z' };

test('预览保留原有航程报价，并携带询价实际范围', async () => {
  const source = await fixtureSource(baseFixture);
  try {
    const view = await preview(new SourceClient(source.url));
    assert.equal(view.entries.length, 1);
    assert.deepEqual(view.inquiry.passengers, ['ADT1', 'INF1']);
    assert.deepEqual(view.inquiry.segments, ['SHA-SIN', 'SIN-SHA']);
    assert.equal(view.inquiry.currency, 'CNY');
  } finally { await source.close(); }
});

test('成人去程托运行李不扩给婴儿或回程：缺说明逐项标出旅客与航段', async () => {
  const handle = await runCollect(baseFixture);
  try {
    const dossier = handle.result.dossiers[0];
    assert.equal(dossier.status, 'incomplete');
    const baggage = handle.archive.records(scope).find(row => row.business_key.startsWith('dossier:')).record.coverage.find(item => item.kind === 'baggage');
    const keys = baggage.missing.map(cell => cell.passenger + '@' + cell.segment).sort();
    // 成人去程与回程各有独立说明，婴儿两格无说明，成人额度没有扩给婴儿
    assert.deepEqual(keys, ['INF1@SHA-SIN', 'INF1@SIN-SHA']);
    // 成人去程格确实已覆盖，没有被悄悄扩大
    assert.ok(!keys.includes('ADT1@SHA-SIN'));
  } finally { await cleanup(handle); }
});

test('三类说明齐备时资料包完整，且每个结论可逐项追到询价与引用集合', async () => {
  const relations = { digest: 'r1', record: fullRelations() };
  const dossier = buildDossier({ inquiry, offer: fullOffer, offerDigest: 'o1', relations, statements: statementMap(relations.record.entries), now: NOW });
  assert.equal(dossier.status, 'complete');
  assert.equal(dossier.references.length, 5);
  assert.ok(dossier.references.every(ref => ref.query === 'Q1' && typeof ref.digest === 'string' && ref.digest.length > 0));
  assert.deepEqual(dossier.coverage.map(item => item.kind), SERVICE_KINDS);
  assert.ok(dossier.coverage.every(item => item.missing.length === 0));
});

test('齐备但过期的说明标记为 complete-expired，不与缺件混淆', () => {
  const relations = { digest: 'r1', record: fullRelations() };
  const statements = statementMap(relations.record.entries, () => ({ expires: '2026-11-01T00:00:00Z' }));
  const dossier = buildDossier({ inquiry, offer: fullOffer, offerDigest: 'o1', relations, statements, now: NOW });
  assert.equal(dossier.status, 'complete-expired');
  assert.deepEqual(dossier.expired.sort(), ['A1', 'B1', 'C1']);
});

test('同一旅客航段格内同类型说明互相冲突时给出 conflict 而不是任选一份', () => {
  const relations = { digest: 'r1', record: interpretRelations({ query: 'Q1', offer: 'O100', services: [
    makeEntry('B1', 'baggage', ['ADT1'], ['SHA-SIN']),
    makeEntry('B2', 'baggage', ['ADT1'], ['SHA-SIN']),
    makeEntry('C1', 'change', ['ADT1', 'INF1'], ['SHA-SIN', 'SIN-SHA']),
    makeEntry('A1', 'ancillary', ['ADT1', 'INF1'], ['SHA-SIN', 'SIN-SHA']),
  ] }) };
  const statements = statementMap(relations.record.entries, id => ({ description: id === 'B2' ? '另一件不同的行李额度' : '说明-' + id }));
  const dossier = buildDossier({ inquiry, offer: fullOffer, offerDigest: 'o1', relations, statements, now: NOW });
  assert.equal(dossier.status, 'conflict');
  assert.ok(dossier.conflicts.some(item => item.code === 'overlapping-statements' && item.passenger === 'ADT1' && item.segment === 'SHA-SIN'));
});

test('同一服务编号在历次收件中出现不同原文时标记重报，不静默复用', async () => {
  const handle = await runCollect(baseFixture);
  try {
    handle.source.replace('/shopping/Q1/services/S1', { body: makeStatement('S1', 'baggage', '更新后的成人去程行李说明', { amount: '100.00' }) });
    const again = await collect(new SourceClient(handle.source.url), handle.archive, scope);
    const stored = handle.archive.records(scope).filter(row => row.business_key.startsWith('dossier:'));
    assert.ok(stored.length >= 2);
    const latest = again.dossiers[0];
    assert.ok(latest.reissued.includes('S1'));
    // 报价原文没有变化：新税费没有被塞进旧总价
    assert.equal(new Set(stored.map(row => row.record.offerDigest)).size, 1);
    const statementRows = handle.archive.records(scope).filter(row => row.business_key === 'statement:Q1:S1');
    assert.equal(statementRows.length, 2);
  } finally { await cleanup(handle); }
});

test('来源只肯重报部分航段时形成另一份报价资料包，原报价历史依据与总价原样保留', async () => {
  const partialFixture = structuredClone(baseFixture);
  partialFixture.resources['/shopping/Q1'].body.offers.push({ id: 'O200', href: '/shopping/Q1/records/O200' });
  partialFixture.resources['/shopping/Q1/records/O200'] = { body: {
    offer: 'O200', query: 'Q1', currency: 'CNY', total: '1310.00',
    segments: ['SHA-SIN'], passengers: ['ADT1', 'INF1'], expires: '2027-02-01T00:00:00Z',
  } };
  partialFixture.resources['/shopping/Q1/relations/O200'] = { body: { query: 'Q1', offer: 'O200', services: [
    makeEntry('P1', 'baggage', ['ADT1', 'INF1'], ['SHA-SIN']),
    makeEntry('P2', 'change', ['ADT1', 'INF1'], ['SHA-SIN']),
    makeEntry('P3', 'ancillary', ['ADT1', 'INF1'], ['SHA-SIN']),
  ] } };
  for (const id of ['P1', 'P2', 'P3']) partialFixture.resources[`/shopping/Q1/services/${id}`] = { body: makeStatement(id, id === 'P1' ? 'baggage' : id === 'P2' ? 'change' : 'ancillary', '部分航段重报-' + id) };
  const handle = await runCollect(partialFixture);
  try {
    const receipts = handle.archive.records(scope);
    const original = receipts.find(row => row.business_key === 'Q1:O100');
    const newOne = receipts.find(row => row.business_key === 'Q1:O200');
    assert.equal(original.record.total, 1250.5);
    assert.equal(newOne.record.total, 1310.0);
    const dossiers = receipts.filter(row => row.business_key.startsWith('dossier:')).map(row => row.record);
    const d200 = dossiers.find(item => item.offer === 'O200');
    assert.equal(d200.status, 'incomplete');
    const missingSegments = new Set(d200.coverage.flatMap(item => item.missing.map(cell => cell.segment)));
    assert.deepEqual([...missingSegments], ['SIN-SHA']);
    assert.ok(dossiers.some(item => item.offer === 'O100'));
    assert.notEqual(dossiers.find(item => item.offer === 'O100').digest, d200.digest);
  } finally { await cleanup(handle); }
});

test('同编号引用越过本次询价路径时拒绝，跨询价编号不可直接复用', async () => {
  const crossFixture = structuredClone(baseFixture);
  crossFixture.resources['/shopping/Q1/relations/O100'].body.services[0].ref = '/shopping/Q2/services/S1';
  const handle = await runCollect(crossFixture);
  try {
    const dossier = handle.archive.records(scope).find(row => row.business_key.startsWith('dossier:')).record;
    assert.equal(dossier.status, 'conflict');
    assert.ok(dossier.conflicts.some(item => item.code === 'statement-unavailable'));
  } finally { await cleanup(handle); }
});

test('关联资料整体缺失时不虚报齐备，资料包标记冲突并保留原因', async () => {
  const missingFixture = structuredClone(baseFixture);
  delete missingFixture.resources['/shopping/Q1/relations/O100'];
  const handle = await runCollect(missingFixture);
  try {
    const dossier = handle.archive.records(scope).find(row => row.business_key.startsWith('dossier:')).record;
    assert.equal(dossier.status, 'conflict');
    assert.ok(dossier.conflicts.some(item => item.code === 'relations-unavailable'));
    assert.ok(dossier.references.some(ref => ref.type === 'offer'));
  } finally { await cleanup(handle); }
});

test('资料包结论按摘要落库，重跑同一依据不产生第二份资料包收据', async () => {
  const handle = await runCollect(baseFixture);
  try {
    const before = handle.archive.records(scope).filter(row => row.business_key.startsWith('dossier:')).length;
    await collect(new SourceClient(handle.source.url), handle.archive, scope);
    const after = handle.archive.records(scope).filter(row => row.business_key.startsWith('dossier:')).length;
    assert.equal(before, after);
  } finally { await cleanup(handle); }
});

test('报价必须落在询价指定的币种、旅客组合与航段内', () => {
  const record = interpret({ offer: 'O100', query: 'Q1', currency: 'CNY', total: '1250.50', segments: ['SHA-SIN', 'SIN-SHA'], passengers: ['ADT1', 'INF1'], expires: '2027-01-01T00:00:00Z' });
  assert.equal(assess(record, [], scope, inquiry).status, 'accepted');
  assert.equal(assess({ ...record, currency: 'USD' }, [], scope, inquiry).status, 'conflict');
  assert.equal(assess({ ...record, passengers: ['ADT1', 'CHD2'] }, [], scope, inquiry).status, 'conflict');
  assert.equal(assess({ ...record, segments: ['SHA-SIN', 'SIN-HKG'] }, [], scope, inquiry).status, 'conflict');
  // 不传询价时保持原有判断行为，历史调用方不受影响
  assert.equal(assess(record, [], scope).status, 'accepted');
});

test('服务说明原文声明的询价不同时领域拒绝，编号相同也不能复用', () => {
  const relations = { digest: 'r1', record: fullRelations() };
  const statements = statementMap(relations.record.entries, id => id === 'B1' ? { query: 'Q2' } : {});
  const dossier = buildDossier({ inquiry, offer: fullOffer, offerDigest: 'o1', relations, statements, now: NOW });
  assert.equal(dossier.status, 'conflict');
  assert.ok(dossier.conflicts.some(item => item.code === 'statement-context' && item.service === 'B1'));
  assert.deepEqual(dossier.references.filter(ref => ref.type === 'statement').map(ref => ref.id), ['C1', 'A1']);
});

test('关联引用的旅客或航段不在报价范围内时拒绝该引用，不替来源扩大适用面', () => {
  const relations = { digest: 'r1', record: interpretRelations({ query: 'Q1', offer: 'O100', services: [
    makeEntry('B1', 'baggage', ['CHD9'], ['SHA-SIN']),
    makeEntry('C1', 'change', ['ADT1', 'INF1'], ['SHA-SIN', 'SIN-SHA']),
    makeEntry('A1', 'ancillary', ['ADT1', 'INF1'], ['SHA-SIN', 'SIN-SHA']),
  ] }) };
  const statements = statementMap(relations.record.entries);
  const dossier = buildDossier({ inquiry, offer: fullOffer, offerDigest: 'o1', relations, statements, now: NOW });
  assert.equal(dossier.status, 'conflict');
  assert.ok(dossier.conflicts.some(item => item.code === 'reference-outside-offer' && item.service === 'B1'));
});
