import { browse, retrieve, retrieveRelations, retrieveService } from './source.mjs';
import { interpret, interpretInquiry, interpretRelations, interpretStatement } from './interpret.mjs';
import { assess, summarize } from './receiving.mjs';
import { buildDossier } from './dossier.mjs';

export async function preview(client) {
  const manifest = await browse(client);
  const entries = [];
  for (const ref of manifest.references) {
    const document = await retrieve(client, ref);
    entries.push(interpret(document.raw));
  }
  return { context: manifest.context, inquiry: manifest.inquiry, entries };
}

// 历次收件中同一服务编号对应的原文摘要：编号只在本次询价内有效，
// 同一编号在另一次询价中即使文字金额相同也不构成可复用的同一依据
function priorStatementDigests(archive, scope) {
  const map = new Map();
  for (const row of archive.records(scope)) {
    if (!row.business_key.startsWith('statement:')) continue;
    const id = row.record?.id;
    if (!id) continue;
    if (!map.has(id)) map.set(id, []);
    if (!map.get(id).includes(row.digest)) map.get(id).push(row.digest);
  }
  return map;
}

async function collectDossier(client, archive, scope, inquiry, offer, offerDigest) {
  let relations = null;
  let relationDigest = null;
  try {
    const relationDocument = await retrieveRelations(client, inquiry.query, offer.offer);
    relationDigest = await archive.preserve(relationDocument);
    relations = { digest: relationDigest, record: interpretRelations(relationDocument.raw) };
  } catch (error) {
    relations = { error: true, reason: error.message };
  }

  const statements = new Map();
  for (const entry of relations.record?.entries ?? []) {
    try {
      const document = await retrieveService(client, inquiry.query, entry.href);
      const digest = await archive.preserve(document);
      const record = interpretStatement(document.raw);
      archive.put(scope, 'statement:' + inquiry.query + ':' + entry.id, digest, record, { status: 'referenced', offer: offer.offer, kind: record.kind });
      statements.set(entry.id, { digest, record });
    } catch (error) {
      statements.set(entry.id, { error: true, reason: error.message });
    }
  }

  const dossier = buildDossier({
    inquiry, offer, offerDigest, relations, statements,
    priorStatementDigests: priorStatementDigests(archive, scope),
  });
  // 资料包摘要由归档层对实际保管字节计算，领域结论不自行编号，避免结论与证据脱节
  dossier.digest = await archive.preserveEvidence(dossier);
  archive.put(scope, 'dossier:' + inquiry.query + ':' + offer.offer + ':' + offerDigest, dossier.digest, dossier, { status: dossier.status });
  return dossier;
}

export async function collect(client, archive, scope, operator) {
  const manifest = await browse(client);
  const inquiry = interpretInquiry({
    query: manifest.inquiry.query, currency: manifest.inquiry.currency,
    passengers: manifest.inquiry.passengers, segments: manifest.inquiry.segments,
  });
  const outcomes = [];
  const dossiers = [];
  for (const reference of manifest.references) {
    let digest;
    let record = null;
    try {
      const document = await retrieve(client, reference);
      digest = await archive.preserve(document);
      record = interpret(document.raw);
      const prior = archive.records(scope).filter(item => item.decision.status === 'accepted').map(item => item.record);
      const decision = assess(record, prior, scope, inquiry);
      if (operator && decision.status === 'accepted') decision.portal = await operator(record);
      archive.put(scope, decision.key ?? reference.identity, digest, record, decision);
      outcomes.push({ reference: reference.identity, digest, ...decision });
    } catch (error) {
      outcomes.push({ reference: reference.identity, digest, status: 'error', reason: error.message });
    }
    // 服务说明资料包与报价收件隔离：资料包不完整不改变报价结论，也不代下单
    if (record) {
      try {
        const dossier = await collectDossier(client, archive, scope, inquiry, record, digest);
        dossiers.push({ reference: reference.identity, digest: dossier.digest, status: dossier.status, conflicts: dossier.conflicts.length, missing: dossier.coverage.map(item => item.missing.length).reduce((a, b) => a + b, 0), expired: dossier.expired, reissued: dossier.reissued });
      } catch (error) {
        dossiers.push({ reference: reference.identity, status: 'error', reason: error.message });
      }
    }
  }
  return { context: manifest.context, inquiry, ...summarize(outcomes), dossiers };
}
