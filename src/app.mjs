import { browse, retrieve } from './source.mjs';
import { interpret, interpretInquiry, interpretRelations, interpretService } from './interpret.mjs';
import { assess, assessScope, assessReissue, evaluateOfferPackage, summarize, summarizePackages } from './receiving.mjs';
import { SourceError } from './http.mjs';

export async function preview(client) {
  const manifest = await browse(client);
  const entries = [];
  for (const ref of manifest.references) {
    const document = await retrieve(client, ref);
    entries.push(interpret(document.raw));
  }
  return { context: manifest.context, entries };
}

export async function collect(client, archive, scope, operator) {
  const manifest = await browse(client);
  const outcomes = [];
  for (const reference of manifest.references) {
    let digest;
    try {
      const document = await retrieve(client, reference);
      digest = await archive.preserve(document);
      const record = interpret(document.raw);
      const prior = archive.records(scope).filter(item => item.decision.status === 'accepted').map(item => item.record);
      const decision = assess(record, prior, scope);
      if (operator && decision.status === 'accepted') decision.portal = await operator(record);
      archive.put(scope, decision.key ?? reference.identity, digest, record, decision);
      outcomes.push({ reference: reference.identity, digest, ...decision });
    } catch (error) {
      outcomes.push({ reference: reference.identity, digest, status: 'error', reason: error.message });
    }
  }
  return { context: manifest.context, ...summarize(outcomes) };
}

function failureReason(error) {
  if (error instanceof SourceError) return '来源未提供资料（' + (error.status || '无响应') + '）：' + error.message;
  return error.message;
}

// 采集报价引用的服务资料（行李、改签、附加服务）；不代下单，不改动原报价总价。
export async function collectServices(client, archive, scope, options = {}) {
  const path = options.path ?? ('/shopping/' + scope);
  const now = options.now ?? new Date();
  const manifest = await browse(client, path);
  if (!manifest.inquiry) throw new Error('来源目录未声明询价范围，无法按旅客组合、航段与币种接收报价');
  const inquiry = interpretInquiry({ ...manifest.inquiry, query: manifest.context });
  if (inquiry.query !== scope) throw new Error('目录询价范围与收件范围不一致');
  const outcomes = [];
  const packages = [];
  for (const reference of manifest.references) {
    let offerDigest = null;
    try {
      const document = await retrieve(client, reference);
      offerDigest = await archive.preserve(document);
      const offer = interpret(document.raw);
      const scopeCheck = assessScope(offer, inquiry);
      if (!scopeCheck.ok) {
        const decision = { status: 'outside', reason: scopeCheck.reason };
        archive.put(scope, 'offer:' + reference.identity, offerDigest, offer, decision);
        outcomes.push({ reference: reference.identity, digest: offerDigest, ...decision });
        continue;
      }
      const prior = archive.records(scope).map(item => item.record);
      const decision = assessReissue(offer, prior, inquiry);
      archive.put(scope, decision.key, offerDigest, offer, decision);
      outcomes.push({ reference: reference.identity, digest: offerDigest, ...decision });
      if (decision.status !== 'accepted') {
        packages.push({ offer: offer.offer, query: offer.query, status: 'conflict', items: [], note: decision.reason });
        continue;
      }

      let relations = null;
      let relationsDigest = null;
      const failures = [];
      if (reference.relations === null) {
        failures.push({ key: null, reason: '报价未声明服务引用位置' });
      } else {
        try {
          const relationsDocument = await client.get(reference.relations);
          relationsDigest = await archive.preserve(relationsDocument);
          relations = interpretRelations(relationsDocument.raw, offer, { prefix: manifest.path });
          archive.put(scope, 'relations:' + offer.offer, relationsDigest, { query: offer.query, offer: offer.offer, ref: reference.relations }, { status: 'accepted' });
        } catch (error) {
          failures.push({ key: null, reason: failureReason(error) });
        }
      }

      const statements = new Map();
      const unavailable = [];
      const conflicts = relations ? relations.conflicts : [];
      const conflictKeys = new Set(conflicts.map(entry => entry.key));
      for (const serviceReference of relations ? relations.services : []) {
        const key = serviceReference.type + ':' + serviceReference.id;
        if (conflictKeys.has(key)) continue;
        try {
          const serviceDocument = await client.get(serviceReference.ref);
          const digest = await archive.preserve(serviceDocument);
          const statement = interpretService(serviceDocument.raw, serviceReference, offer);
          statement.digest = digest;
          statement.location = serviceDocument.location;
          statements.set(key, statement);
          archive.put(scope, 'service:' + offer.offer + ':' + key, digest, statement, { status: 'accepted' });
        } catch (error) {
          if (error instanceof SourceError) {
            unavailable.push({ key, reason: failureReason(error) });
          } else {
            conflicts.push({ key, id: serviceReference.id, type: serviceReference.type, reason: failureReason(error) });
          }
        }
      }

      const result = evaluateOfferPackage(offer, relations ? relations.services : [], statements, conflicts, unavailable, now, relationsDigest);
      if (failures.length) result.failures = failures;
      if (decision.note) result.note = decision.note;
      if (decision.reissues) result.reissues = decision.reissues;
      packages.push(result);
    } catch (error) {
      outcomes.push({ reference: reference.identity, digest: offerDigest, status: 'error', reason: error.message });
    }
  }
  const packageSummary = summarizePackages(packages);
  const outcomeCounts = {};
  for (const outcome of outcomes) outcomeCounts[outcome.status] = (outcomeCounts[outcome.status] ?? 0) + 1;
  return {
    context: manifest.context,
    inquiry,
    complete: packageSummary.complete && outcomes.every(outcome => outcome.status === 'accepted'),
    counts: packageSummary.counts,
    outcomeCounts,
    outcomes,
    packages: packageSummary.packages,
  };
}
