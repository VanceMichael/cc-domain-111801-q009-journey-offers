import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SourceClient } from '../src/http.mjs';
import { Archive } from '../src/archive.mjs';
import { fixtureSource } from '../src/fixture-source.mjs';
import { collect, collectServices } from '../src/app.mjs';

async function run(fixtureFile, label, services) {
  const fixture = JSON.parse(await readFile(new URL(fixtureFile, import.meta.url), 'utf8'));
  const source = await fixtureSource(fixture);
  const directory = await mkdtemp(join(tmpdir(), 'journey-offers-'));
  const archive = await new Archive(directory).start();
  try {
    const client = new SourceClient(source.url);
    const result = services
      ? await collectServices(client, archive, fixture.scope)
      : await collect(client, archive, fixture.scope);
    console.log('=== ' + label + ' ===');
    console.log(JSON.stringify(result, null, 2));
    console.log('已保存原文与收件记录：', archive.records(fixture.scope).length);
    if (!result.complete) process.exitCode = 1;
  } finally {
    archive.close();
    await source.close();
    await rm(directory, { recursive: true, force: true });
  }
}

await run('../fixtures/source.json', '常规报价收件（Q1）', false);
await run('../fixtures/service-package.json', '服务资料包采集（Q9：缺失/过期/冲突/部分重报/范围外）', true);
