export function assess(record, previous, scope, inquiry) {
  if (record.query !== scope) return { status: 'outside', reason: '不是同一次询价' };
  // 一次询价有指定的旅客组合、航段和币种：报价必须落在该实际范围内
  if (inquiry) {
    if (record.currency !== inquiry.currency) return { status: 'conflict', reason: '报价币种与询价不一致' };
    const outsidePassenger = record.passengers.find(passenger => !inquiry.passengers.includes(passenger));
    if (outsidePassenger) return { status: 'conflict', reason: '报价旅客超出询价范围：' + outsidePassenger };
    const outsideSegment = record.segments.find(segment => !inquiry.segments.includes(segment));
    if (outsideSegment) return { status: 'conflict', reason: '报价航段超出询价范围：' + outsideSegment };
  }
           const prior = previous.find(item => item.offer === record.offer && (item.currency !== record.currency || item.total !== record.total));
           if (prior) return { status: 'conflict', reason: '同一报价的总价或币种不同' };
           return { status: 'accepted', key: record.query + ':' + record.offer, facts: { offer: record.offer, query: record.query, total: record.total, currency: record.currency, expires: record.expires } };
}

export function summarize(outcomes) {
  const counts = {};
  for (const outcome of outcomes) counts[outcome.status] = (counts[outcome.status] ?? 0) + 1;
  return { complete: outcomes.length > 0 && outcomes.every(outcome => outcome.status === 'accepted'), counts, outcomes };
}
