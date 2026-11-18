export function assess(record, previous, scope) {
  if (record.query !== scope) return { status: 'outside', reason: '不是同一次询价' };
           const prior = previous.find(item => item.offer === record.offer && (item.currency !== record.currency || item.total !== record.total));
           if (prior) return { status: 'conflict', reason: '同一报价的总价或币种不同' };
           return { status: 'accepted', key: record.query + ':' + record.offer, facts: { offer: record.offer, query: record.query, total: record.total, currency: record.currency, expires: record.expires } };
}

export function summarize(outcomes) {
  const counts = {};
  for (const outcome of outcomes) counts[outcome.status] = (counts[outcome.status] ?? 0) + 1;
  return { complete: outcomes.length > 0 && outcomes.every(outcome => outcome.status === 'accepted'), counts, outcomes };
}
