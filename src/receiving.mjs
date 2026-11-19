import { SERVICE_TYPES } from './interpret.mjs';

export function assess(record, previous, scope) {
  if (record.query !== scope) return { status: 'outside', reason: '不是同一次询价' };
  const prior = previous.find(item => item.offer === record.offer && (item.currency !== record.currency || item.total !== record.total));
  if (prior) return { status: 'conflict', reason: '同一报价的总价或币种不同' };
  return { status: 'accepted', key: record.query + ':' + record.offer, facts: { offer: record.offer, query: record.query, total: record.total, currency: record.currency, expires: record.expires } };
}

export function assessScope(record, inquiry) {
  if (!inquiry || record.query !== inquiry.query) return { ok: false, reason: '不是同一次询价' };
  if (record.currency !== inquiry.currency) return { ok: false, reason: '报价币种与询价币种不同' };
  const passenger = record.passengers.find(name => !inquiry.passengers.includes(name));
  if (passenger) return { ok: false, reason: '报价旅客超出询价组合：' + passenger };
  const segment = record.segments.find(name => !inquiry.segments.includes(name));
  if (segment) return { ok: false, reason: '报价航段超出询价行程：' + segment };
  return { ok: true };
}

function expectedCells(offer) {
  const cells = [];
  for (const passenger of offer.passengers) {
    for (const segment of offer.segments) cells.push(passenger + '@' + segment);
  }
  return cells;
}

function itemKey(reference) {
  return reference.type + ':' + reference.id;
}

// 只按来源实际声明的旅客×航段单元格核对，不把成人去程的说明扩给婴儿或回程。
export function evaluateOfferPackage(offer, references, statements, conflicts, unavailable, now = new Date(), relationsDigest = null) {
  const items = [];
  for (const type of SERVICE_TYPES) {
    const byType = references.filter(reference => reference.type === type);
    const covered = new Set();
    for (const reference of byType) {
      const key = itemKey(reference);
      const statement = statements.get(key);
      const failure = unavailable.find(entry => entry.key === key);
      const referenceConflict = conflicts.find(entry => entry.key === key);
      const state = referenceConflict
        ? 'conflict'
        : failure
          ? 'missing'
          : statement
            ? Date.parse(statement.expires) <= now.getTime() ? 'expired' : 'complete'
            : 'missing';
      const item = {
        key,
        type,
        id: reference.id,
        state,
        passengers: reference.passengers,
        segments: reference.segments,
        ref: reference.ref,
        digest: statement ? statement.digest : undefined,
        expires: statement ? statement.expires : undefined,
      };
      if (referenceConflict) item.reason = referenceConflict.reason;
      else if (failure) item.reason = failure.reason;
      else if (state === 'expired') item.reason = '服务说明已过期';
      else if (state === 'missing') item.reason = '该服务缺少说明原文';
      items.push(item);
      if (state === 'complete' || state === 'expired') {
        for (const passenger of reference.passengers) {
          for (const segment of reference.segments) covered.add(passenger + '@' + segment);
        }
      }
    }
    for (const cell of expectedCells(offer)) {
      if (!covered.has(cell)) {
        items.push({ key: type + ':' + cell, type, id: null, state: 'missing', reason: '报价范围内缺少旅客×航段说明：' + cell });
      }
    }
  }
  let status = 'complete';
  if (items.some(item => item.state === 'conflict')) status = 'conflict';
  else if (items.some(item => item.state === 'missing')) status = 'missing';
  else if (items.some(item => item.state === 'expired')) status = 'expired';
  return {
    offer: offer.offer,
    query: offer.query,
    status,
    items,
    trace: {
      query: offer.query,
      offer: offer.offer,
      relationsDigest,
      references: references.map(reference => ({
        key: itemKey(reference), id: reference.id, type: reference.type,
        passengers: reference.passengers, segments: reference.segments, ref: reference.ref,
      })),
      evidence: [...statements.values()].map(statement => ({
        key: statement.type + ':' + statement.service, service: statement.service, type: statement.type,
        expires: statement.expires, digest: statement.digest, location: statement.location,
      })),
    },
  };
}

// 重报必须严格小于原报价的旅客与航段集合；同范围重报应作为同报价价格冲突处理。
function isStrictSubset(part, whole) {
  return part.length > 0 && part.length < whole.length && part.every(name => whole.includes(name));
}

// 部分航段重报是另一份报价：保留独立总价，禁止把新税费并入原报价。
export function assessReissue(candidate, previous, inquiry) {
  const scope = assessScope(candidate, inquiry);
  if (!scope.ok) return { status: 'outside', reason: scope.reason };
  const sameNumber = previous.find(item => item.offer === candidate.offer);
  if (sameNumber) {
    const identical = sameNumber.currency === candidate.currency
      && sameNumber.total === candidate.total
      && JSON.stringify(sameNumber.passengers) === JSON.stringify(candidate.passengers)
      && JSON.stringify(sameNumber.segments) === JSON.stringify(candidate.segments);
    if (!identical) return { status: 'conflict', reason: '同一报价编号在本询价内出现不同内容' };
  }
  const declarations = candidate.reissues ?? [];
  if (!declarations.length) {
    return { status: 'accepted', key: candidate.query + ':' + candidate.offer, note: '常规报价' };
  }
  for (const declaration of declarations) {
    const predecessor = previous.find(item => item.offer === declaration.offer);
    if (!predecessor) {
      return { status: 'conflict', reason: '重报声明找不到原报价：' + declaration.offer };
    }
    if (!isStrictSubset(declaration.segments, predecessor.segments)) {
      return { status: 'conflict', reason: '重报航段不是原报价的局部航段：' + declaration.offer };
    }
    if (!isStrictSubset(declaration.passengers, predecessor.passengers)) {
      return { status: 'conflict', reason: '重报旅客超出原报价组合：' + declaration.offer };
    }
  }
  return {
    status: 'accepted',
    key: candidate.query + ':' + candidate.offer,
    note: '来源只重报部分航段，这是另一份报价；原报价历史依据与总价保留，未并入新税费',
    reissues: declarations.map(declaration => declaration.offer),
  };
}

export function summarize(outcomes) {
  const counts = {};
  for (const outcome of outcomes) counts[outcome.status] = (counts[outcome.status] ?? 0) + 1;
  return { complete: outcomes.length > 0 && outcomes.every(outcome => outcome.status === 'accepted'), counts, outcomes };
}

export function summarizePackages(packages) {
  const counts = {};
  for (const result of packages) counts[result.status] = (counts[result.status] ?? 0) + 1;
  return {
    complete: packages.length > 0 && packages.every(result => result.status === 'complete'),
    counts,
    packages,
  };
}
