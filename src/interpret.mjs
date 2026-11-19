import { text, decimal } from './validation.mjs';

export const SERVICE_TYPES = ['baggage', 'rebooking', 'ancillary'];

function nameList(value, name) {
  if (!Array.isArray(value) || !value.length) throw new Error('字段缺失或无效：' + name);
  const result = value.map(entry => text(entry, name));
  if (new Set(result).size !== result.length) throw new Error('字段包含重复项：' + name);
  return result;
}

function reissueList(value, name) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.length) throw new Error('字段缺失或无效：' + name);
  return value.map(entry => {
    if (!entry || typeof entry !== 'object') throw new Error('重报声明无效');
    return {
      offer: text(entry.offer, 'reissue.offer'),
      passengers: nameList(entry.passengers, 'reissue.passengers'),
      segments: nameList(entry.segments, 'reissue.segments'),
    };
  });
}

export function interpret(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('来源记录不是对象');
  if (!/^[A-Z]{3}$/.test(raw.currency ?? '') || !Array.isArray(raw.segments) || !raw.segments.length || !Array.isArray(raw.passengers) || !raw.passengers.length) throw new Error('询价币种或行程对象无效');
  const total = decimal(raw.total, 'total');
  if (total < 0 || !Number.isFinite(Date.parse(raw.expires))) throw new Error('报价金额或有效期无效');
  return {
    offer: text(raw.offer, 'offer'),
    query: text(raw.query, 'query'),
    currency: raw.currency,
    total,
    segments: nameList(raw.segments, 'segments'),
    passengers: nameList(raw.passengers, 'passengers'),
    expires: raw.expires,
    reissues: reissueList(raw.reissues, 'reissues'),
  };
}

export function interpretInquiry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('询价目录不是对象');
  const query = text(raw.query, 'query');
  if (!/^[A-Z]{3}$/.test(raw.currency ?? '')) throw new Error('询价币种无效');
  const inquiry = {
    query,
    currency: raw.currency,
    passengers: nameList(raw.passengers, 'inquiry.passengers'),
    segments: nameList(raw.segments, 'inquiry.segments'),
  };
  return inquiry;
}

export function interpretRelations(raw, offer, options = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('服务引用资料不是对象');
  if (raw.query !== offer.query || raw.offer !== offer.offer) throw new Error('服务引用上下文与报价不符');
  if (!Array.isArray(raw.services)) throw new Error('服务引用列表无效');
  const prefix = options.prefix ?? '';
  const services = [];
  const conflicts = [];
  const seen = new Map();
  for (const entry of raw.services) {
    if (!entry || typeof entry !== 'object') throw new Error('服务引用条目无效');
    const reference = {
      id: text(entry.id, 'service.id'),
      type: text(entry.type, 'service.type'),
      passengers: nameList(entry.passengers, 'service.passengers'),
      segments: nameList(entry.segments, 'service.segments'),
      ref: text(entry.ref, 'service.ref'),
    };
    if (!SERVICE_TYPES.includes(reference.type)) throw new Error('服务类型无效：' + reference.type);
    if (!reference.ref.startsWith(prefix + '/')) {
      throw new Error('服务引用越过询价上下文：' + reference.id);
    }
    const outsidePassenger = reference.passengers.find(name => !offer.passengers.includes(name));
    const outsideSegment = reference.segments.find(name => !offer.segments.includes(name));
    const key = reference.type + ':' + reference.id;
    const earlier = seen.get(key);
    if (earlier && (earlier.ref !== reference.ref || JSON.stringify(earlier.passengers) !== JSON.stringify(reference.passengers) || JSON.stringify(earlier.segments) !== JSON.stringify(reference.segments))) {
      conflicts.push({ key, id: reference.id, type: reference.type, reason: '同一服务编号存在互相冲突的引用' });
    } else if (!earlier) {
      seen.set(key, reference);
    }
    if (outsidePassenger || outsideSegment) {
      conflicts.push({
        key, id: reference.id, type: reference.type,
        reason: '服务引用超出报价适用范围：' + [outsidePassenger, outsideSegment].filter(Boolean).join('、'),
      });
    }
    if (!earlier) services.push(reference);
  }
  return { query: raw.query, offer: raw.offer, services, conflicts };
}

function sameNames(actual, expected) {
  return actual.length === expected.length && actual.every(name => expected.includes(name));
}

export function interpretService(raw, reference, offer) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('服务说明原文不是对象');
  if (raw.query !== offer.query) throw new Error('服务说明属于另一次询价，不能按本报价引用复用');
  if (text(raw.service, 'service') !== reference.id || text(raw.type, 'type') !== reference.type) {
    throw new Error('服务说明身份与引用不符：' + reference.id);
  }
  if (!Array.isArray(raw.passengers) || !Array.isArray(raw.segments) || !sameNames(raw.passengers, reference.passengers) || !sameNames(raw.segments, reference.segments)) {
    throw new Error('服务说明适用旅客或航段与引用冲突：' + reference.id);
  }
  if (!Number.isFinite(Date.parse(raw.expires))) throw new Error('服务说明有效期无效：' + reference.id);
  const statement = {
    query: raw.query,
    service: raw.service,
    type: raw.type,
    passengers: raw.passengers,
    segments: raw.segments,
    expires: raw.expires,
  };
  if (raw.amount !== undefined) statement.amount = decimal(raw.amount, 'service.amount');
  return statement;
}
