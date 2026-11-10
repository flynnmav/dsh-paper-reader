import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import ts from 'typescript';

// Hover timing of the paragraph menu: the dwell belongs to the paragraph under
// the pointer, not to the pointer position.
const source = await readFile(new URL('../src/hoverIntent.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
const { createHoverIntent, HOVER_COLD_DELAY, HOVER_WARM_DELAY, HOVER_CLOSE_DELAY } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputText).toString('base64')}`);

test('moving inside one paragraph does not restart the dwell', async () => {
  const intent = createHoverIntent({ cold: 40, warm: 10 });
  const shown = [];
  const started = Date.now();
  for (let x = 0; x < 3; x++) {
    intent.request('p1', () => shown.push({ x, after: Date.now() - started }));
    await sleep(10);
  }
  await sleep(40);
  assert.equal(shown.length, 1);
  assert.ok(shown[0].after < 75, `shown after ${shown[0].after}ms while still moving`);
  assert.equal(shown[0].x, 2, 'the latest pointer sample is the one activated');
});

test('a new paragraph replaces the waiting one', async () => {
  const intent = createHoverIntent({ cold: 30, warm: 10 });
  const shown = [];
  intent.request('p1', () => shown.push('p1'));
  await sleep(10);
  intent.request('p2', () => shown.push('p2'));
  assert.equal(intent.pendingKey(), 'p2');
  await sleep(50);
  assert.deepEqual(shown, ['p2']);
});

test('switching while something is shown uses the shorter delay', async () => {
  const intent = createHoverIntent({ cold: 80, warm: 10 });
  const shown = [];
  intent.request('p2', () => shown.push('p2'), { warm: true });
  await sleep(40);
  assert.deepEqual(shown, ['p2']);
});

test('immediate requests fire synchronously and cancel drops the rest', async () => {
  const intent = createHoverIntent({ cold: 20, warm: 10 });
  const shown = [];
  intent.request('p1', () => shown.push('p1'), { immediate: true });
  assert.deepEqual(shown, ['p1']);
  intent.request('p2', () => shown.push('p2'));
  intent.cancel();
  await sleep(40);
  assert.deepEqual(shown, ['p1']);
});

test('activation can tell that it was superseded', async () => {
  const intent = createHoverIntent({ cold: 5, warm: 5 });
  let check;
  intent.request('figure', current => { check = current; });
  await sleep(20);
  assert.equal(check(), true);
  intent.request('p1', () => {});
  assert.equal(check(), false);
});

test('delays stay in the range that feels immediate', () => {
  assert.ok(HOVER_COLD_DELAY <= 90 && HOVER_WARM_DELAY <= HOVER_COLD_DELAY);
  assert.ok(HOVER_CLOSE_DELAY >= 200 && HOVER_CLOSE_DELAY <= 400);
});
