export interface PdfParagraph {
  key: string;
  elements: HTMLElement[];
  text: string;
  /** One copied bounding rectangle per visual line. */
  rects: DOMRect[];
  /** Contains a display formula (attached scripts or fraction parts). */
  math?: boolean;
}

/** A DOM-independent rectangle used by the geometry functions and their tests. */
export interface PdfParagraphRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface PdfTextFragment {
  text: string;
  rect: PdfParagraphRect;
  fontSize: number;
  /** Present for fragments collected from a text layer, optional in pure geometry tests. */
  element?: HTMLElement;
  /** Position in the text layer (PDF content-stream order). */
  order?: number;
}

export interface PdfVisualLine {
  text: string;
  rect: PdfParagraphRect;
  fontSize: number;
  fragments: PdfTextFragment[];
  /** Set when sub/superscripts or fraction parts were attached (a formula). */
  math?: boolean;
}

const right = (rect: PdfParagraphRect) => rect.left + rect.width;
const bottom = (rect: PdfParagraphRect) => rect.top + rect.height;

function unionRects(rects: PdfParagraphRect[]): PdfParagraphRect {
  const left = Math.min(...rects.map(rect => rect.left));
  const top = Math.min(...rects.map(rect => rect.top));
  const maxRight = Math.max(...rects.map(right));
  const maxBottom = Math.max(...rects.map(bottom));
  return { left, top, width: maxRight - left, height: maxBottom - top };
}

function horizontalOverlap(a: PdfParagraphRect, b: PdfParagraphRect): number {
  return Math.max(0, Math.min(right(a), right(b)) - Math.max(a.left, b.left));
}

function verticalOverlap(a: PdfParagraphRect, b: PdfParagraphRect): number {
  return Math.max(0, Math.min(bottom(a), bottom(b)) - Math.max(a.top, b.top));
}

function joinFragments(fragments: PdfTextFragment[]): string {
  let text = "";
  let previous: PdfTextFragment | undefined;
  for (const fragment of fragments) {
    if (previous) {
      const gap = fragment.rect.left - right(previous.rect);
      // PDF.js normally includes spaces in the text items. Add one only for
      // visibly separated Latin words when the source omitted that space.
      if (gap > Math.max(1, Math.min(previous.fontSize, fragment.fontSize) * 0.12) &&
          /[A-Za-z0-9]$/.test(text) && /^[A-Za-z0-9]/.test(fragment.text)) text += " ";
    }
    text += fragment.text;
    previous = fragment;
  }
  return text.trim();
}

/**
 * Merge baseline-aligned fragments into visual lines. A large horizontal gap
 * starts another line even at the same baseline, which separates page columns.
 */
export function buildPdfVisualLines(fragments: PdfTextFragment[]): PdfVisualLine[] {
  const ordered = fragments
    .filter(fragment => fragment.text.trim() && fragment.rect.width >= 0 && fragment.rect.height > 0 &&
      Number.isFinite(fragment.rect.left) && Number.isFinite(fragment.rect.top) &&
      Number.isFinite(fragment.rect.width) && Number.isFinite(fragment.rect.height))
    .slice()
    .sort((a, b) => bottom(a.rect) - bottom(b.rect) || a.rect.left - b.rect.left);

  const bands: { fragments: PdfTextFragment[]; baseline: number; fontSize: number }[] = [];
  for (const fragment of ordered) {
    let best: (typeof bands)[number] | undefined;
    let bestDistance = Infinity;
    for (const band of bands) {
      const distance = Math.abs(bottom(fragment.rect) - band.baseline);
      const tolerance = Math.max(1.5, Math.min(fragment.fontSize, band.fontSize) * 0.35);
      const overlap = verticalOverlap(fragment.rect, unionRects(band.fragments.map(item => item.rect)));
      if (distance <= tolerance && overlap >= Math.min(fragment.rect.height, band.fragments[0].rect.height) * 0.25 && distance < bestDistance) {
        best = band;
        bestDistance = distance;
      }
    }
    if (best) {
      best.fragments.push(fragment);
      const count = best.fragments.length;
      best.baseline += (bottom(fragment.rect) - best.baseline) / count;
      best.fontSize += (fragment.fontSize - best.fontSize) / count;
    } else {
      bands.push({ fragments: [fragment], baseline: bottom(fragment.rect), fontSize: fragment.fontSize });
    }
  }

  const lines: PdfVisualLine[] = [];
  for (const band of bands) {
    const inReadingOrder = band.fragments.slice().sort((a, b) => a.rect.left - b.rect.left || a.rect.top - b.rect.top);
    let current: PdfTextFragment[] = [];
    let currentRight = 0;
    const flush = () => {
      if (!current.length) return;
      const length = current.reduce((sum, fragment) => sum + Math.max(1, fragment.text.length), 0);
      const fontSize = current.reduce((sum, fragment) => sum + fragment.fontSize * Math.max(1, fragment.text.length), 0) / length;
      lines.push({ text: joinFragments(current), rect: unionRects(current.map(fragment => fragment.rect)), fontSize, fragments: current });
      current = [];
    };
    for (const fragment of inReadingOrder) {
      if (current.length) {
        const previous = current[current.length - 1];
        const gap = fragment.rect.left - currentRight;
        const maxGap = Math.max(2, Math.max(previous.fontSize, fragment.fontSize) * 1.5);
        if (gap > maxGap) flush();
      }
      current.push(fragment);
      currentRight = Math.max(currentRight, right(fragment.rect));
    }
    flush();
  }
  return lines.filter(line => line.text).sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
}

const baselineOf = (line: PdfVisualLine) => bottom(line.rect);

function readingOrder(a: PdfTextFragment, b: PdfTextFragment): number {
  if (a.order !== undefined && b.order !== undefined && a.order !== b.order) return a.order - b.order;
  // The text layer follows the PDF content stream, which is the order the
  // author wrote the formula in (numerator before denominator, base before
  // script). Pure geometry tests have no elements: fall back to x order.
  if (a.element && b.element && a.element !== b.element) {
    return a.element.compareDocumentPosition(b.element) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
  }
  return a.rect.left - b.rect.left || a.rect.top - b.rect.top;
}

/**
 * Attach sub/superscripts, fraction numerators/denominators and radicands to
 * the line they belong to. Such a "satellite" sits on a different baseline
 * (and usually a smaller size), so line building and the paragraph rules
 * (font ratio, one successor) split a display equation into fragments and a
 * hover only covered part of it. A satellite overlaps its host vertically and
 * lies within or right next to it horizontally; prose lines never overlap
 * vertically, and table cells share a baseline, so neither is affected.
 *
 * Every satellite joins exactly one host (the line it overlaps most), so a
 * tall radical or a subscript between two prose lines never fuses those lines.
 */
export function attachPdfScripts(input: PdfVisualLine[]): PdfVisualLine[] {
  const lines = input.slice();
  const host = lines.map((_, index) => index);
  const find = (index: number): number => host[index] === index ? index : (host[index] = find(host[index]));
  // Visual mass: a one-glyph radical in a large font is still a satellite.
  const weight = (line: PdfVisualLine) => Math.max(1, line.rect.width) * line.fontSize;
  const heavier = (a: number, b: number) => weight(lines[a]) > weight(lines[b]) || (weight(lines[a]) === weight(lines[b]) && a < b);
  const horizontalGap = (a: PdfParagraphRect, b: PdfParagraphRect) => Math.max(0, a.left - right(b), b.left - right(a));
  for (let s = 0; s < lines.length; s++) {
    const small = lines[s];
    let best = -1, bestOverlap = 0;
    for (let l = 0; l < lines.length; l++) {
      if (l === s || !heavier(l, s)) continue;
      const large = lines[l];
      const size = Math.max(small.fontSize, large.fontSize);
      if (Math.abs(baselineOf(small) - baselineOf(large)) < size * 0.2) continue;
      const overlap = verticalOverlap(small.rect, large.rect);
      const minimumHeight = Math.min(small.rect.height, large.rect.height);
      if (overlap < minimumHeight * 0.15) continue;
      // Two long lines of similar width are consecutive prose lines whose boxes
      // touch (a tall glyph enlarges one of them), not a formula and its part.
      if (small.rect.width > size * 12 && small.rect.width > large.rect.width * 0.6 && overlap < minimumHeight * 0.5) continue;
      const reach = size * 1.2;
      const inside = small.rect.left >= large.rect.left - reach && right(small.rect) <= right(large.rect) + reach;
      // An exponent after the last glyph of a line piece sticks out of it
      // (and a short base such as "e" is lighter than its long exponent).
      const script = Math.min(small.fontSize, large.fontSize) <= size * 0.8 && horizontalGap(small.rect, large.rect) <= size * 0.6;
      if (!inside && !script) continue;
      if (overlap > bestOverlap) { best = l; bestOverlap = overlap; }
    }
    if (best >= 0) host[find(s)] = find(best);
  }
  // A formula's own pieces on its main baseline can be split apart by a gap
  // (an unstretched one-glyph span such as "√" renders narrower than in the
  // PDF, or an exponent sits between them). Rejoin same-baseline neighbours of
  // a formula within two glyph widths; an equation number far to the right
  // stays separate.
  for (let changed = true; changed;) {
    changed = false;
    const members = new Map<number, number[]>();
    lines.forEach((_, index) => { const root = find(index); const list = members.get(root); if (list) list.push(index); else members.set(root, [index]); });
    for (const [root, indexes] of members) {
      if (indexes.length < 2) continue;
      const extent = unionRects(indexes.map(index => lines[index].rect));
      for (let b = 0; b < lines.length; b++) {
        if (find(b) === root) continue;
        const piece = lines[b];
        const joins = indexes.some(a => {
          const formula = lines[a];
          const size = Math.max(formula.fontSize, piece.fontSize);
          return Math.abs(baselineOf(formula) - baselineOf(piece)) < size * 0.2 &&
            verticalOverlap(formula.rect, piece.rect) >= Math.min(formula.rect.height, piece.rect.height) * 0.5 &&
            horizontalGap(extent, piece.rect) <= size * 2;
        });
        if (!joins) continue;
        host[find(b)] = root;
        changed = true;
        break;
      }
      if (changed) break;
    }
  }
  const clusters = new Map<number, PdfVisualLine[]>();
  lines.forEach((line, index) => {
    const root = find(index);
    const cluster = clusters.get(root);
    if (cluster) cluster.push(line); else clusters.set(root, [line]);
  });
  const merged: PdfVisualLine[] = [];
  for (const cluster of clusters.values()) {
    if (cluster.length === 1) { merged.push(cluster[0]); continue; }
    const base = cluster.reduce((best, line) => weight(line) > weight(best) ? line : best);
    const fragments = cluster.flatMap(line => line.fragments).sort(readingOrder);
    merged.push({ text: joinFragments(fragments), rect: unionRects(cluster.map(line => line.rect)), fontSize: base.fontSize, fragments, math: true });
  }
  return merged.sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
}

function hasColumnOverlap(a: PdfVisualLine, b: PdfVisualLine): boolean {
  const minimumWidth = Math.min(a.rect.width, b.rect.width);
  return horizontalOverlap(a.rect, b.rect) >= Math.max(1, minimumWidth * 0.15);
}

function canContinueParagraph(previous: PdfVisualLine, current: PdfVisualLine): boolean {
  const fontRatio = Math.min(previous.fontSize, current.fontSize) / Math.max(previous.fontSize, current.fontSize);
  if (fontRatio < 0.75) return false;
  const gap = current.rect.top - bottom(previous.rect);
  // Academic PDFs often use block paragraphs with no first-line indent.
  // SuperMimic body lines are ~2px apart at 9.96px font size, while paragraph
  // boundaries are ~6.4px apart; a generous line-height threshold merges the
  // whole section. Keep the threshold below that inter-paragraph gap.
  return gap <= Math.max(2, Math.min(previous.fontSize, current.fontSize) * 0.45);
}

/**
 * Group lines into linear paragraph chains. Each line chooses its nearest
 * overlapping line above; incompatible or already-continued lines start a new
 * paragraph. The one-successor rule stops a full-width line bridging columns.
 */
export function groupPdfVisualLines(input: PdfVisualLine[]): PdfVisualLine[][] {
  const lines = input.slice().sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
  const parents = lines.map(() => -1);
  const children = lines.map(() => -1);

  for (let index = 1; index < lines.length; index++) {
    const current = lines[index];
    let nearest = -1;
    let nearestDistance = Infinity;
    for (let candidate = 0; candidate < index; candidate++) {
      const previous = lines[candidate];
      const minimumHeight = Math.min(previous.rect.height, current.rect.height);
      // Require a genuinely later baseline rather than another fragment on the
      // same visual row whose rectangle happens to overlap vertically.
      if (bottom(current.rect) - bottom(previous.rect) <= minimumHeight * 0.45) continue;
      if (!hasColumnOverlap(previous, current)) continue;
      const distance = Math.max(0, current.rect.top - bottom(previous.rect));
      if (distance < nearestDistance) {
        nearest = candidate;
        nearestDistance = distance;
      }
    }
    if (nearest >= 0 && children[nearest] < 0 && canContinueParagraph(lines[nearest], current)) {
      parents[index] = nearest;
      children[nearest] = index;
    }
  }

  const paragraphs: PdfVisualLine[][] = [];
  for (let index = 0; index < lines.length; index++) {
    if (parents[index] >= 0) continue;
    const paragraph: PdfVisualLine[] = [];
    let cursor = index;
    while (cursor >= 0) {
      paragraph.push(lines[cursor]);
      cursor = children[cursor];
    }
    paragraphs.push(paragraph);
  }
  return paragraphs;
}

const EQUATION_NUMBER = /^\(\s*[A-Z]?\.?\d+(\.\d+)*[a-z]?\s*\)$/;
const MATH_SIGN = /[=≈≠≡≤≥<>±×÷∑∏∫∂∇√∞∈∉⊂⊆∪∩∀∃→←↔⇒⇔⊗⊕∝∼]/;
const DELIMITER = /^[\s\[\](){}|‖⟨⟩〈〉]{1,3}$/;
const LIST_MARKER = /^\s*(?:[•·▪■◦*\-–—]|\(?[0-9a-zA-Z]{1,2}[.)]\s)/;
const CONTINUATION = /^\s*(?:[a-zα-ω]|(?:[Ww]here|[Hh]ere|[Ww]ith|[Ii]n which|[Ss]uch that|[Ss]ubject to)\b|其中|式中|这里|此处)/;

interface FormulaBlock {
  lines: PdfVisualLine[];
  rect: PdfParagraphRect;
  fontSize: number;
  /** The block is only a formula so far (no prose above it). */
  pure: boolean;
  /** Left edge of the block's prose. */
  proseLeft?: number;
  /** Set while the block's last part is a display formula. */
  tail?: PdfParagraphRect;
}

/**
 * A display equation is typeset between the sentence that introduces it and,
 * often, a continuation ("where …"). The paragraph rules see three blocks
 * (the equation is centred and set apart), so a hover covered either the prose
 * or the equation, never the statement as a whole. This joins
 *   - an equation number with its equation,
 *   - a display equation with the paragraph right above it,
 *   - a following paragraph that continues the sentence (lower-case start or
 *     "where/with/…"), and a paragraph right below an equation that has no
 *     paragraph above it.
 * An equation is recognised by layout plus content: a few lines, inset from
 * the left edge of the paragraph above, alone on its rows, and containing a
 * relation/operator sign, attached scripts or an equation number.
 */
export function mergeDisplayFormulas(groups: PdfVisualLine[][]): PdfVisualLine[][] {
  interface Item { lines: PdfVisualLine[]; rect: PdfParagraphRect; own: PdfParagraphRect; fontSize: number; text: string; numbered: boolean; used: boolean }
  const items: Item[] = groups.filter(lines => lines.length).map(lines => {
    const rect = unionRects(lines.map(line => line.rect));
    return { lines: lines.slice(), rect, own: rect, fontSize: lines.reduce((sum, line) => sum + line.fontSize, 0) / lines.length, text: lines.map(line => line.text).join(' '), numbered: false, used: false };
  }).sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
  const mathy = (item: Item) => item.numbered || item.lines.some(line => line.math) || MATH_SIGN.test(item.text);

  const mathyLine = (line: PdfVisualLine) => !!line.math || MATH_SIGN.test(line.text);
  const absorb = (host: Item, piece: Item) => {
    host.lines.push(...piece.lines);
    host.rect = unionRects([host.rect, piece.rect]);
    piece.used = true;
  };
  // 1a. Equation numbers join the equation on their rows (also when the
  // equation line already belongs to a paragraph).
  const isNumber = (item: Item) => item.lines.length === 1 && EQUATION_NUMBER.test(item.text.trim());
  for (const number of items) {
    if (!isNumber(number)) continue;
    let best: Item | undefined, bestGap = Infinity;
    for (const item of items) {
      if (item === number || item.used || isNumber(item)) continue;
      for (const line of item.lines) {
        if (!mathyLine(line) || verticalOverlap(line.rect, number.rect) < number.rect.height * 0.5) continue;
        const gap = Math.max(number.rect.left - right(line.rect), line.rect.left - right(number.rect));
        if (gap >= 0 && gap < bestGap) { best = item; bestGap = gap; }
      }
    }
    if (!best) continue;
    absorb(best, number);
    best.numbered = true;
  }
  // 1b. Stray tall delimiters ("[", "]", "‖") drawn beside a formula row.
  for (const piece of items) {
    if (piece.used || piece.lines.length !== 1 || !DELIMITER.test(piece.text)) continue;
    const host = items.find(item => item !== piece && !item.used && item.lines.some(line => mathyLine(line) &&
      piece.rect.top + piece.rect.height / 2 >= line.rect.top - line.fontSize && piece.rect.top + piece.rect.height / 2 <= bottom(line.rect) + line.fontSize * 0.5 &&
      piece.rect.left >= line.rect.left - line.fontSize * 2 && right(piece.rect) <= right(line.rect) + line.fontSize * 2));
    if (host) absorb(host, piece);
  }
  // 1c. Pieces on the rows of a numbered equation, between it and its number
  // (conditions such as "l = 1 … L" in an aligned column).
  for (const host of items) {
    if (host.used || !host.numbered || host.lines.length > 16) continue;
    for (const piece of items) {
      if (piece === host || piece.used || piece.lines.length > 2) continue;
      if (piece.rect.left < host.rect.left || right(piece.rect) > right(host.rect)) continue;
      if (!host.lines.some(line => verticalOverlap(line.rect, piece.rect) >= piece.rect.height * 0.5)) continue;
      const before = host.rect;
      absorb(host, piece);
      host.rect = before;
    }
  }
  const rest = items.filter(item => !item.used);

  // Rows, not pieces: a numbered equation with side conditions has several pieces per row.
  const rows = (item: Item) => item.lines.reduce((seen: PdfParagraphRect[], line) => {
    if (!seen.some(rect => verticalOverlap(rect, line.rect) >= Math.min(rect.height, line.rect.height) * 0.5)) seen.push(line.rect);
    return seen;
  }, []).length;
  const numbered = (item: Item) => item.numbered || item.lines.some(line => mathyLine(line) && /\(\d{1,3}(?:\.\d+)?[a-z]?\)\s*$/.test(line.text));
  const isFormula = (item: Item) => rows(item) <= 8 && mathy(item) && !LIST_MARKER.test(item.lines[0].text);
  const blocks: FormulaBlock[] = [];
  const above = (item: Item): FormulaBlock | undefined => {
    let best: FormulaBlock | undefined, bestGap = Infinity;
    for (const block of blocks) {
      if (horizontalOverlap(block.rect, item.rect) <= 0) continue;
      const gap = item.rect.top - bottom(block.rect);
      if (gap < -Math.min(block.fontSize, item.fontSize) * 0.3 || gap >= bestGap) continue;
      best = block; bestGap = gap;
    }
    return best;
  };
  const aloneOnRows = (item: Item, lane: PdfParagraphRect) => rest.every(other => other === item ||
    verticalOverlap(other.rect, item.rect) <= Math.min(other.rect.height, item.rect.height) * 0.3 ||
    horizontalOverlap(other.rect, lane) <= 0);
  const add = (block: FormulaBlock, item: Item, formula: boolean) => {
    if (formula) item.lines.forEach(line => { line.math = true; });
    block.lines.push(...item.lines);
    block.rect = unionRects([block.rect, item.rect]);
    block.tail = formula ? item.own : undefined;
    if (!formula) { block.pure = false; block.proseLeft = Math.min(block.proseLeft ?? Infinity, item.rect.left); }
  };

  for (const item of rest) {
    const block = above(item);
    const formula = isFormula(item);
    if (block) {
      const font = Math.min(block.fontSize, item.fontSize);
      const near = item.rect.top - bottom(block.rect) <= Math.max(block.fontSize, item.fontSize) * 3.5;
      const inset = block.proseLeft !== undefined && item.own.left - block.proseLeft >= font * 1.8;
      if (formula && near && aloneOnRows(item, block.rect)) {
        // Below prose: inset and inside its column. Below a lone equation: its next row.
        const reach = block.pure ? font * 4 : font;
        // (the paragraph above may end in a short line, so only a lone equation bounds the right side)
        const within = item.rect.left >= block.rect.left - reach && (!block.pure || right(item.rect) <= right(block.rect) + reach);
        if (within && (block.pure ? rows(item) <= 3 && (item.numbered || item.lines.some(line => line.math) || item.rect.width < block.rect.width * 1.5) : inset || (numbered(item) && rows(item) <= 2))) { add(block, item, true); continue; }
      }
      if (block.tail && near && !inset && item.rect.left <= block.tail.left &&
          (CONTINUATION.test(item.lines[0].text) || (block.pure && item.lines.length > 1))) {
        add(block, item, false);
        continue;
      }
    }
    // A formula with no paragraph above it (top of a column): the paragraph below may join it.
    const lone = formula && (item.numbered || item.lines.every(line => line.math)) && rows(item) <= 3;
    // A paragraph may already end with its equation (tight line spacing).
    const last = item.lines.reduce((low, line) => bottom(line.rect) > bottom(low.rect) && !EQUATION_NUMBER.test(line.text.trim()) ? line : low, item.lines[0]);
    const endsWithFormula = !lone && item.lines.length > 1 && mathyLine(last) && last.rect.left - item.rect.left >= item.fontSize * 1.8;
    blocks.push({ lines: item.lines, rect: item.rect, fontSize: item.fontSize, pure: lone, tail: lone ? item.own : endsWithFormula ? last.rect : undefined, proseLeft: lone ? undefined : item.rect.left });
  }
  return blocks.map(block => block.lines.slice().sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left));

}

/**
 * Many papers separate paragraphs only by a first-line indent (no extra
 * spacing), and a section heading sits right above its first paragraph. Split
 * a chain at an indented line between two flush lines, and after a leading
 * line in a clearly larger font.
 */
export function splitIndentedParagraphs(groups: PdfVisualLine[][]): PdfVisualLine[][] {
  const out: PdfVisualLine[][] = [];
  for (const lines of groups) {
    if (lines.length < 3) { out.push(lines); continue; }
    const lefts = lines.map(line => line.rect.left).sort((a, b) => a - b);
    const flush = lefts[Math.floor((lefts.length - 1) / 2)];
    const width = Math.max(...lines.map(line => right(line.rect))) - flush;
    let current: PdfVisualLine[] = [lines[0]];
    for (let index = 1; index < lines.length; index++) {
      const line = lines[index], previous = lines[index - 1], next = lines[index + 1];
      const size = line.fontSize;
      const indent = line.rect.left - flush;
      const isFlush = (other: PdfVisualLine) => Math.abs(other.rect.left - flush) < size * 0.5;
      const indented = indent >= size * 0.8 && indent <= size * 2.6 && isFlush(previous) &&
        (next ? isFlush(next) : line.rect.width > width * 0.5) && right(line.rect) >= flush + width - size * 2;
      const afterHeading = index === 1 && previous.fontSize >= line.fontSize * 1.08 && previous.rect.width < width * 0.9;
      if (indented || afterHeading) { out.push(current); current = []; }
      current.push(line);
    }
    out.push(current);
  }
  return out;
}

/** Fragments of one page → hover paragraphs (lines grouped, formulas attached). */
export function recognisePdfParagraphs(fragments: PdfTextFragment[]): PdfVisualLine[][] {
  return mergeDisplayFormulas(splitIndentedParagraphs(groupPdfVisualLines(attachPdfScripts(buildPdfVisualLines(fragments)))));
}

interface PdfParagraphCache {
  paragraphs: PdfParagraph[];
  elements: HTMLElement[];
  /** Client-space layer bounds used to translate cached line rects on scroll. */
  layerRect: PdfParagraphRect;
}

const paragraphCache = new WeakMap<HTMLElement, PdfParagraphCache>();

function readFontSize(element: HTMLElement, layer: HTMLElement): number {
  const view = layer.ownerDocument.defaultView;
  const value = view ? Number.parseFloat(view.getComputedStyle(element).fontSize) : Number.NaN;
  const rectHeight = element.getBoundingClientRect().height;
  return Number.isFinite(value) && value > 0 ? value : rectHeight > 0 ? rectHeight : 12;
}

function collectFragments(layer: HTMLElement): PdfTextFragment[] {
  const fragments: PdfTextFragment[] = [];
  for (const element of layer.querySelectorAll<HTMLElement>("span")) {
    if (element.querySelector("span") || element.closest(".markedContent")) continue;
    const text = element.textContent || "";
    if (!text.trim()) continue;
    const bounds = element.getBoundingClientRect();
    if (!bounds.width || !bounds.height) continue;
    fragments.push({
      element,
      order: fragments.length,
      text,
      rect: { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height },
      fontSize: readFontSize(element, layer),
    });
  }
  return fragments;
}

function buildParagraphs(layer: HTMLElement, pageNumber: number): PdfParagraph[] {
  const groups = recognisePdfParagraphs(collectFragments(layer));
  return groups.map((lines, index) => ({
    key: `pdf-${pageNumber}-paragraph-${index + 1}`,
    elements: lines.flatMap(line => line.fragments.flatMap(fragment => fragment.element ? [fragment.element] : [])),
    text: lines.map(line => line.text).join("\n"),
    rects: lines.map(line => new DOMRect(line.rect.left, line.rect.top, line.rect.width, line.rect.height)),
    math: lines.some(line => line.math),
  }));
}

function clientRect(rect: { left: number; top: number; width: number; height: number }): PdfParagraphRect {
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}

/** The page's paragraphs, with client rectangles kept current while scrolling. */
function pageParagraphs(layer: HTMLElement, pageNumber: number): PdfParagraph[] {
  let cache = paragraphCache.get(layer);
  // PdfPage replaces all spans on zoom but retains the layer element itself.
  // Checking only the WeakMap key would therefore return detached elements and
  // coordinates from the previous zoom.
  const intact = cache && cache.elements.length > 0 &&
    layer.contains(cache.elements[0]) && layer.contains(cache.elements[cache.elements.length - 1]);
  if (!cache || !intact) {
    const paragraphs = buildParagraphs(layer, pageNumber);
    cache = {
      paragraphs,
      elements: paragraphs.flatMap(paragraph => paragraph.elements),
      layerRect: clientRect(layer.getBoundingClientRect()),
    };
    paragraphCache.set(layer, cache);
  } else {
    const bounds = layer.getBoundingClientRect();
    if (bounds.width !== cache.layerRect.width || bounds.height !== cache.layerRect.height) {
      // A same-DOM layout change (for example a CSS resize) needs fresh geometry.
      const paragraphs = buildParagraphs(layer, pageNumber);
      cache = { paragraphs, elements: paragraphs.flatMap(paragraph => paragraph.elements), layerRect: clientRect(bounds) };
      paragraphCache.set(layer, cache);
    } else {
      // DOMRects are client coordinates, not document coordinates. Translate
      // them when scrolling instead of leaving highlights at the old position.
      const dx = bounds.left - cache.layerRect.left;
      const dy = bounds.top - cache.layerRect.top;
      if (dx || dy) {
        for (const paragraph of cache.paragraphs) {
          paragraph.rects = paragraph.rects.map(rect => new DOMRect(rect.left + dx, rect.top + dy, rect.width, rect.height));
        }
        cache.layerRect = clientRect(bounds);
      }
    }
  }
  return cache.paragraphs;
}

/** Find the cached paragraph containing a text-layer element. */
export function findPdfParagraph(target: Element, layer: HTMLElement, pageNumber: number): PdfParagraph | null {
  if (!layer.contains(target)) return null;
  return pageParagraphs(layer, pageNumber).find(paragraph => paragraph.elements.some(element => element === target || element.contains(target))) || null;
}

/**
 * Pick a paragraph by position. A line under the point wins; otherwise the
 * smallest paragraph whose outline contains it, so the gaps between words and
 * lines (and the white space beside a display formula) still count as inside.
 */
export function pickParagraphAt<T extends { rects: ArrayLike<PdfParagraphRect> }>(paragraphs: readonly T[], x: number, y: number, slack = 2): T | null {
  const inside = (rect: PdfParagraphRect, pad: number) => x >= rect.left - pad && x <= rect.left + rect.width + pad && y >= rect.top - pad && y <= rect.top + rect.height + pad;
  let best: T | null = null, bestArea = Infinity;
  for (const paragraph of paragraphs) {
    const rects = Array.from(paragraph.rects);
    if (!rects.length) continue;
    const outline = unionRects(rects);
    if (!inside(outline, slack + 2)) continue;
    const onLine = rects.some(rect => inside(rect, slack));
    const area = onLine ? 0 : Math.max(1, outline.width * outline.height);
    if (area < bestArea) { best = paragraph; bestArea = area; }
  }
  return best;
}

/** Find the paragraph at a client position of a page's text layer. */
export function findPdfParagraphAt(layer: HTMLElement, pageNumber: number, x: number, y: number): PdfParagraph | null {
  return pickParagraphAt(pageParagraphs(layer, pageNumber), x, y);
}
