import { text } from './validation.mjs';

export const collectionPath = "/shopping/Q1";

export async function browse(client, path = collectionPath) {
  const document = await client.get(path);
  const raw = document.raw;
  const context = text(raw.query, "query");
  if (!Array.isArray(raw.offers)) throw new Error('来源目录结构无效');
  const references = raw.offers.map(entry => ({
    identity: text(entry.id, 'id'),
    href: text(entry.href, 'href'),
    relations: typeof entry.relations === 'string' && entry.relations.trim() ? entry.relations : null,
    context,
  }));
  if (new Set(references.map(entry => entry.identity)).size !== references.length) throw new Error('目录包含重复来源身份');
  for (const reference of references) {
    if (reference.relations !== null && !reference.relations.startsWith(path + '/')) {
      throw new Error('服务引用位置越过询价目录：' + reference.identity);
    }
  }
  const manifest = { context, references, path };
  if (raw.currency !== undefined) {
    if (!Array.isArray(raw.passengers) || !raw.passengers.length || !Array.isArray(raw.segments) || !raw.segments.length) {
      throw new Error('询价范围声明无效');
    }
    manifest.inquiry = { query: context, currency: raw.currency, passengers: [...raw.passengers], segments: [...raw.segments] };
  }
  return manifest;
}

export async function retrieve(client, reference) {
  const document = await client.get(reference.href);
  if (document.raw.offer !== reference.identity) throw new Error('原文身份与目录引用不符');
  if (document.raw.query !== reference.context) throw new Error('原文上下文与目录不符');
  return document;
}
