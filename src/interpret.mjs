import { text, decimal, list } from './validation.mjs';

export function interpret(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('来源记录不是对象');
  if (!/^[A-Z]{3}$/.test(raw.currency ?? '') || !Array.isArray(raw.segments) || !raw.segments.length || !Array.isArray(raw.passengers) || !raw.passengers.length) throw new Error('询价币种或行程对象无效');
           const total = decimal(raw.total, 'total');
           if (total < 0 || !Number.isFinite(Date.parse(raw.expires))) throw new Error('报价金额或有效期无效');
           return { offer: text(raw.offer, 'offer'), query: text(raw.query, 'query'), currency: raw.currency, total, segments: raw.segments, passengers: raw.passengers, expires: raw.expires };
}

// 一次询价有指定的旅客组合、航段和币种，资料包按这个实际范围逐项核对
export function interpretInquiry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('询价目录不是对象');
  const query = text(raw.query, 'query');
  const currency = text(raw.currency, 'currency');
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error('询价币种无效');
  return { query, currency, passengers: list(raw.passengers, 'passengers'), segments: list(raw.segments, 'segments') };
}

const SERVICE_KINDS = ['baggage', 'change', 'ancillary'];

// 关联资料：报价引用的服务说明集合，逐项声明旅客与航段适用范围
export function interpretRelations(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('关联资料不是对象');
  const query = text(raw.query, 'query');
  const offer = text(raw.offer, 'offer');
  if (!Array.isArray(raw.services)) throw new Error('关联服务列表无效');
  const entries = raw.services.map((entry, index) => {
    if (!entry || typeof entry !== 'object') throw new Error('关联服务项无效：' + index);
    return {
      id: text(entry.id, 'services[' + index + '].id'),
      kind: text(entry.kind, 'services[' + index + '].kind'),
      passengers: list(entry.passengers, 'services[' + index + '].passengers'),
      segments: list(entry.segments, 'services[' + index + '].segments'),
      href: text(entry.ref, 'services[' + index + '].ref'),
    };
  });
  return { query, offer, entries };
}

// 服务说明原文：行李、改签与附加服务说明，金额缺省表示来源不另行收费或未报价
export function interpretStatement(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('服务说明不是对象');
  const query = text(raw.query, 'query');
  const id = text(raw.id, 'id');
  const kind = text(raw.kind, 'kind');
  if (!SERVICE_KINDS.includes(kind)) throw new Error('服务类型无效：' + kind);
  const description = text(raw.description, 'description');
  let amount;
  if (raw.amount !== undefined && raw.amount !== null) amount = decimal(raw.amount, 'amount');
  if (!Number.isFinite(Date.parse(raw.expires))) throw new Error('服务说明有效期无效');
  return { query, id, kind, description, amount, currency: raw.currency ? text(raw.currency, 'currency') : undefined, expires: raw.expires };
}
