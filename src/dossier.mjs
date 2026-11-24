export const SERVICE_KINDS = ['baggage', 'change', 'ancillary'];

function addConflict(conflicts, code, message, references = {}) {
  conflicts.push({ code, message, ...references });
}

// 按询价的完整旅客×航段矩阵核对，重报部分航段的报价会自然暴露出未覆盖格
function matrix(passengers, segments) {
  const cells = [];
  for (const passenger of passengers) for (const segment of segments) cells.push({ passenger, segment });
  return cells;
}

/**
 * 形成一份报价的服务说明资料包。纯领域逻辑：不发起请求、不写存储，
 * 所有原文证据以摘要引用，保证资料包可逐项追到询价与引用集合。
 */
export function buildDossier({ inquiry, offer, offerDigest, relations, statements, priorStatementDigests = new Map(), now = Date.now() }) {
  const conflicts = [];
  const relationDigest = relations?.digest;
  const entries = [];
  const seenIds = new Map();

  if (!relations || relations.error) {
    addConflict(conflicts, 'relations-unavailable', '关联资料未能取得：' + (relations?.reason ?? '来源未发布'), { relation: relationsPathText(offer) });
  } else {
    if (relations.record.query !== inquiry.query) addConflict(conflicts, 'relation-context', '关联资料不属于本次询价');
    if (relations.record.offer !== offer.offer) addConflict(conflicts, 'relation-offer', '关联资料不属于该报价');
    for (const entry of relations.record.entries) {
      if (!SERVICE_KINDS.includes(entry.kind)) {
        addConflict(conflicts, 'unknown-kind', '服务类型无效：' + entry.kind, { service: entry.id });
        continue;
      }
      const badPassenger = entry.passengers.find(passenger => !offer.passengers.includes(passenger));
      const badSegment = entry.segments.find(segment => !offer.segments.includes(segment));
      if (badPassenger || badSegment) {
        addConflict(conflicts, 'reference-outside-offer', '引用的旅客或航段不在报价范围内', {
          service: entry.id, passenger: badPassenger, segment: badSegment,
        });
        continue;
      }
      const earlier = seenIds.get(entry.id);
      if (earlier) {
        // 同一编号重复出现：指向完全相同才视为冗余重列，否则是报价内部引用互相冲突
        if (earlier.href !== entry.href) addConflict(conflicts, 'duplicate-reference', '同一服务编号指向不同引用', { service: entry.id });
        continue;
      }
      seenIds.set(entry.id, entry);
      entries.push(entry);
    }
  }

  const statementItems = [];
  for (const entry of entries) {
    const fetched = statements.get(entry.id);
    if (!fetched || fetched.error) {
      addConflict(conflicts, 'statement-unavailable', '服务说明未能取得：' + (fetched?.reason ?? '来源未发布'), { service: entry.id, href: entry.href });
      continue;
    }
    const record = fetched.record;
    if (record.query !== inquiry.query) {
      addConflict(conflicts, 'statement-context', '服务说明不属于本次询价', { service: entry.id });
      continue;
    }
    if (record.id !== entry.id) {
      addConflict(conflicts, 'statement-identity', '服务说明编号与引用不符', { service: entry.id, actual: record.id });
      continue;
    }
    if (record.kind !== entry.kind) {
      addConflict(conflicts, 'statement-kind', '服务说明类型与引用不符', { service: entry.id });
      continue;
    }
    if (record.currency && record.currency !== inquiry.currency) {
      addConflict(conflicts, 'statement-currency', '服务说明币种与询价不一致', { service: entry.id });
      continue;
    }
    const reissued = (priorStatementDigests.get(entry.id) ?? []).some(digest => digest !== fetched.digest);
    const expired = Date.parse(record.expires) <= now;
    statementItems.push({
      id: entry.id, kind: entry.kind, description: record.description,
      amount: record.amount, currency: record.currency ?? inquiry.currency,
      expires: record.expires, expired, reissued,
      passengers: entry.passengers, segments: entry.segments,
      digest: fetched.digest, relationDigest,
    });
  }

  // 报价内部引用互相冲突：同一旅客×航段格内，同类型出现文字或金额不同的多份说明
  const cellsByKind = new Map();
  for (const kind of SERVICE_KINDS) cellsByKind.set(kind, new Map());
  for (const item of statementItems) {
    for (const passenger of item.passengers) {
      for (const segment of item.segments) {
        const key = passenger + ' ' + segment;
        const cell = cellsByKind.get(item.kind);
        if (!cell.has(key)) cell.set(key, []);
        cell.get(key).push(item);
      }
    }
  }
  for (const [kind, cell] of cellsByKind) {
    for (const [key, items] of cell) {
      const distinct = new Set(items.map(item => item.digest));
      if (distinct.size > 1) {
        const [passenger, segment] = key.split(' ');
        addConflict(conflicts, 'overlapping-statements', '同一旅客航段的' + kind + '说明互相冲突', {
          kind, passenger, segment, services: items.map(item => item.id),
        });
      }
    }
  }

  const coverage = [];
  let hasMissing = false;
  let hasExpired = false;
  for (const kind of SERVICE_KINDS) {
    const missing = [];
    for (const { passenger, segment } of matrix(inquiry.passengers, inquiry.segments)) {
      const items = cellsByKind.get(kind).get(passenger + ' ' + segment) ?? [];
      const usable = items.filter(item => !conflicts.some(conflict => conflict.code === 'overlapping-statements' && conflict.services?.includes(item.id)));
      if (usable.length === 0) {
        missing.push({ passenger, segment });
        hasMissing = true;
      } else if (usable.every(item => item.expired)) {
        hasExpired = true;
      }
      if (items.some(item => item.expired)) hasExpired = true;
    }
    coverage.push({ kind, missing });
  }

  const references = [{ type: 'offer', id: offer.offer, digest: offerDigest, query: inquiry.query }];
  if (relationDigest) references.push({ type: 'relations', id: offer.offer, digest: relationDigest, query: inquiry.query });
  for (const item of statementItems) references.push({ type: 'statement', id: item.id, digest: item.digest, query: inquiry.query });

  let status;
  if (conflicts.length > 0) status = 'conflict';
  else if (hasMissing) status = 'incomplete';
  else if (hasExpired) status = 'complete-expired';
  else status = 'complete';

  return {
    query: inquiry.query,
    offer: offer.offer,
    offerDigest,
    relationDigest: relationDigest ?? null,
    inquiry: { currency: inquiry.currency, passengers: inquiry.passengers, segments: inquiry.segments },
    offerScope: { passengers: offer.passengers, segments: offer.segments },
    status,
    conflicts,
    coverage,
    expired: statementItems.filter(item => item.expired).map(item => item.id),
    reissued: statementItems.filter(item => item.reissued).map(item => item.id),
    statements: statementItems,
    references,
  };
}

function relationsPathText(offer) {
  return '/shopping/' + encodeURIComponent(offer.query) + '/relations/' + encodeURIComponent(offer.offer);
}
