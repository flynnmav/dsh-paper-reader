import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../src/paragraphs.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
const { recognisePdfParagraphs, pickParagraphAt } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputText).toString('base64')}`);

let order = 0;
const piece = (text, left, top, width, fontSize = 10) => ({ text, rect: { left, top, width, height: fontSize * 1.1 }, fontSize, order: order++ });
const prose = (top, lines, left = 100) => lines.map((text, index) => piece(text, left, top + index * 12, index === lines.length - 1 && lines.length > 1 ? 300 : 400));
const texts = groups => groups.map(lines => lines.map(line => line.text).join(' | '));

test('a display equation joins the paragraph that introduces it, with its number and the "where" clause', () => {
  const groups = recognisePdfParagraphs([
    ...prose(100, ['The output of the layer is computed from the input and', 'the learned parameters as follows:']),
    piece('y = W x + b', 240, 136, 110),
    piece('(1)', 480, 136, 14),
    ...prose(160, ['where W is the weight matrix and b is the bias of the layer', 'that are learned during training.']),
    ...prose(210, ['Another paragraph starts here and talks about something', 'entirely different from the equation.']),
  ]);
  const merged = texts(groups);
  assert.equal(merged.length, 2, merged.join('\n'));
  assert.match(merged[0], /as follows:.*y = W x \+ b.*\(1\).*where W is/);
  assert.ok(groups[0].some(line => line.math));
  assert.match(merged[1], /^Another paragraph/);
});

test('a following paragraph that does not continue the sentence stays separate', () => {
  const groups = recognisePdfParagraphs([
    ...prose(100, ['The loss is defined over all samples of the batch and', 'reads as follows:']),
    piece('L = a + b', 240, 136, 90),
    ...prose(160, ['Training uses a fixed learning rate for all the layers', 'unless noted otherwise.']),
  ]);
  const merged = texts(groups);
  assert.equal(merged.length, 2, merged.join('\n'));
  assert.match(merged[0], /L = a \+ b$/);
});

test('position lookup counts line gaps and formula margins as inside the paragraph', () => {
  const a = { key: 'a', rects: [{ left: 100, top: 100, width: 400, height: 11 }, { left: 240, top: 136, width: 110, height: 11 }] };
  const b = { key: 'b', rects: [{ left: 100, top: 200, width: 400, height: 11 }, { left: 100, top: 212, width: 300, height: 11 }] };
  const label = { key: 'label', rects: [{ left: 300, top: 118, width: 20, height: 8 }] };
  assert.equal(pickParagraphAt([a, b], 150, 105)?.key, 'a');
  assert.equal(pickParagraphAt([a, b], 120, 140)?.key, 'a', 'white space left of the equation');
  assert.equal(pickParagraphAt([a, b], 450, 216)?.key, 'b', 'after a short last line');
  assert.equal(pickParagraphAt([a, b], 300, 170), null, 'between paragraphs');
  assert.equal(pickParagraphAt([a, label], 305, 121)?.key, 'label', 'a line under the pointer beats an enclosing outline');
});
