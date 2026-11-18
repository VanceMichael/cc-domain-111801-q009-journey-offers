import { text, decimal } from './validation.mjs';

export function interpret(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('来源记录不是对象');
  if (!/^[A-Z]{3}$/.test(raw.currency ?? '') || !Array.isArray(raw.segments) || !raw.segments.length || !Array.isArray(raw.passengers) || !raw.passengers.length) throw new Error('询价币种或行程对象无效');
           const total = decimal(raw.total, 'total');
           if (total < 0 || !Number.isFinite(Date.parse(raw.expires))) throw new Error('报价金额或有效期无效');
           return { offer: text(raw.offer, 'offer'), query: text(raw.query, 'query'), currency: raw.currency, total, segments: raw.segments, passengers: raw.passengers, expires: raw.expires };
}
