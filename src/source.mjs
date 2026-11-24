import { text, list } from './validation.mjs';

export const collectionPath = "/shopping/Q1";

function inquiryPath(query) {
  return '/shopping/' + encodeURIComponent(query);
}
export function relationsPath(query, offer) {
  return inquiryPath(query) + '/relations/' + encodeURIComponent(offer);
}
export function servicePath(query, id) {
  return inquiryPath(query) + '/services/' + encodeURIComponent(id);
}
// 引用编号只在本次询价内有意义：任何服务引用必须落在该询价自己的路径下
export function referenceWithinQuery(query, href) {
  const prefix = inquiryPath(query) + '/';
  return typeof href === 'string' && href.startsWith(prefix) && !href.includes('..');
}

export async function browse(client) {
  const document = await client.get(collectionPath);
  const raw = document.raw;
  const context = text(raw.query, "query");
  const currency = text(raw.currency, 'currency');
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error('询价币种无效');
  const passengers = list(raw.passengers, 'passengers');
  const segments = list(raw.segments, 'segments');
  if (!Array.isArray(raw.offers)) throw new Error('来源目录结构无效');
  const references = raw.offers.map(entry => ({
    identity: text(entry.id, 'id'), href: text(entry.href, 'href'), context,
  }));
  if (new Set(references.map(entry => entry.identity)).size !== references.length) throw new Error('目录包含重复来源身份');
  return { context, inquiry: { query: context, currency, passengers, segments }, references };
}
export async function retrieve(client, reference) {
  const document = await client.get(reference.href);
  if (document.raw.offer !== reference.identity) throw new Error('原文身份与目录引用不符');
  if (document.raw.query !== reference.context) throw new Error('原文上下文与目录不符');
  return document;
}
export async function retrieveRelations(client, query, offer) {
  const document = await client.get(relationsPath(query, offer));
  const raw = document.raw;
  if (raw.query !== query) throw new Error('关联资料不属于本次询价');
  if (raw.offer !== offer) throw new Error('关联资料不属于该报价');
  return document;
}
export async function retrieveService(client, query, href) {
  if (!referenceWithinQuery(query, href)) throw new Error('服务引用越过本次询价范围');
  const document = await client.get(href);
  return document;
}
