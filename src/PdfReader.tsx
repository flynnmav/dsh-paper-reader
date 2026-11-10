import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import { findPdfParagraphAt, type PdfParagraphRect } from './paragraphs';
import { createHoverIntent, HOVER_CLOSE_DELAY, SCROLL_SETTLE_DELAY } from './hoverIntent';
import { collectPdfFigures, findPdfFigureAtPoint, invalidatePdfFigureCache, type PdfFigure } from './figures';
import { positionMarginOverlay, positionReaderOverlay, isPointInOverlayBridge, type OverlayRect } from './overlayGeometry';
import { ReaderIcon } from './icons';
import { createPdfRenderQueue, type PdfRenderQueue } from './renderQueue';
import { createTaskScheduler, type TaskScheduler } from './taskScheduler';
import { createTextLayerJob, hasSelectableText } from './textLayer';
import { createResidency, type Residency } from './residency';
import { openPdfDocument, type PdfHandle, type PdfImageRects, type PdfOutlineItem } from './documentStore';
import { resolveDestination, previewTextAt, type PdfDestination, type PdfLink } from './links';
import { searchIndex as searchPageIndex, normaliseQuery, type SearchHit, type SearchRect } from './search';
import { fitWidthScale, loadPrefs, loadView, savePrefs, saveView, type ReaderPrefs, type SavedView } from './viewState';
import { cleanPdfText, looksLikeMath } from './textCleanup';
import { pdfContentKey } from './contentKey';
import { installSelectionGuard } from './selectionGuard';
import { buildTraceReport, runProbe, traceEvent, traceMount, tracePage, traceTextSlice } from './trace';

export type PdfReaderAction = "explain" | "translate" | "ask" | "copy";
export interface PdfQuote {
  text: string;
  pageStart: number;
  pageEnd: number;
  kind?: 'text' | 'figure';
  image?: Blob;
}
export interface PdfReaderProps {
  data: Uint8Array;
  fileName: string;
  sessionId: string;
  /** URL of the matching pdfjs-dist worker, supplied by the host. */
  workerSrc: string;
  onAction: (action: PdfReaderAction, quote: PdfQuote) => void;
  /** Disable the selectable text layer when selection is not needed. Defaults to true. */
  enableTextLayer?: boolean;
  /** Remember the current page and zoom for this key during the current session. */
  stateKey?: string;
  /** Short-lived UI feedback; does not change the PDF or draft. */
  statusMessage?: string;
  /** Generate and export the accumulated reading notes for this paper. */
  onGenerateNotes?: () => void;
}

const readerStates = new Map<string, SavedView>();
let nextReaderInstance = 0;

const MIN_SCALE = 0.25;
const MAX_SCALE = 3;
const SCALE_STEP = 0.25;
const clampScale = (value: number) => Math.max(MIN_SCALE, Math.min(MAX_SCALE, value));
/** Canvas render band: pages this close to the viewport get a sharp bitmap. */
const RENDER_MARGIN = "800px 0px";
/** Text band: only pages about to be read get a selectable text layer. */
const TEXT_MARGIN = "240px 0px";
/** Cap one page bitmap at 2^24 pixels (64 MiB RGBA); larger zooms use a lower DPR. */
const MAX_CANVAS_PIXELS = 1 << 24;
const PLACEHOLDER_DIVISOR = 4;
const FIGURE_CAPTION = /^\s*(Figure|Fig\.?|Table)\s+(\d+|[IVXLC]+)\b/i;

type MenuState = {
  quote: PdfQuote;
  anchor: OverlayRect;
  origin?: 'pointer' | 'keyboard';
  mode: 'selection' | 'hover' | 'figure';
  key?: string;
  capture?: CaptureJob;
  returnFocus?: HTMLElement | null;
  imageReady?: Promise<Blob | undefined>;
  highlights?: Array<{ left: number; top: number; width: number; height: number }>;
  /** A hover paragraph that contains a display formula. */
  math?: boolean;
};
type CaptureJob = {
  key: string;
  controller: AbortController;
  promise: Promise<Blob | undefined>;
  claimed: boolean;
  done: boolean;
  blob?: Blob;
};

/** empty: nothing drawn · loading: first render · placeholder: low-res copy · stale: old bitmap while re-rendering. */
type CanvasStatus = 'empty' | 'loading' | 'placeholder' | 'stale' | 'ready' | 'error';
type TextStatus = 'none' | 'loading' | 'ready' | 'empty' | 'error';

type PageSearchRect = SearchRect & { active: boolean };
export type LinkEvent = 'activate' | 'enter' | 'leave';
type PageProps = {
  doc: PdfHandle;
  night: boolean;
  searchRects?: PageSearchRect[];
  onLink: (link: PdfLink, event: LinkEvent, element: HTMLElement) => void;
  number: number;
  scale: number;
  textEnabled: boolean;
  initialSize: { width: number; height: number };
  scrollRoot: HTMLElement | null;
  renderQueue: PdfRenderQueue;
  textScheduler: TaskScheduler;
  residency: Residency;
};

const isCancelled = (error: unknown) => !!error && typeof error === 'object' &&
  ((error as { name?: string }).name === 'RenderingCancelledException' || (error as { name?: string }).name === 'AbortError' || (error as { name?: string }).name === 'AbortException');

/**
 * pdf.js (display intent) answers each continuation with its own
 * requestAnimationFrame before drawing the next ~15 ms slice. The shared render
 * queue already grants exactly one slice per frame, so that second hop only
 * doubles the frames a page needs and hides the drawing time from the trace.
 * Capture that single synchronous rAF request and run the slice now.
 */
function runInThisFrame(continueWork: () => void) {
  const original = window.requestAnimationFrame;
  const captured: FrameRequestCallback[] = [];
  const capture = ((callback: FrameRequestCallback) => { captured.push(callback); return 0; }) as typeof window.requestAnimationFrame;
  try { window.requestAnimationFrame = capture; } catch { /* non-writable in this host */ }
  if (window.requestAnimationFrame !== capture) { continueWork(); return; }
  try { continueWork(); }
  finally { window.requestAnimationFrame = original; }
  if (captured.length === 1) captured[0](performance.now());
  else for (const callback of captured) original.call(window, callback);
}

function selectionCovers(element: Element): boolean {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) return false;
  for (let index = 0; index < selection.rangeCount; index++) {
    try { if (selection.getRangeAt(index).intersectsNode(element)) return true; } catch { /* detached */ }
  }
  return false;
}

const percent = (value: number, total: number) => `${(100 * value / total).toFixed(3)}%`;

const PdfPage = React.memo(function PdfPage({ doc, number, scale, textEnabled, initialSize, scrollRoot, renderQueue, textScheduler, residency, night, searchRects, onLink }: PageProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const previousRender = useRef<Promise<unknown>>(Promise.resolve());
  const [size, setSize] = useState(initialSize);
  const [near, setNear] = useState(false);
  const [inView, setInView] = useState(false);
  const [canvasStatus, setCanvasStatus] = useState<CanvasStatus>('empty');
  const [textStatus, setTextStatus] = useState<TextStatus>('none');
  const [canvasEpoch, setCanvasEpoch] = useState(0);
  const [textEpoch, setTextEpoch] = useState(0);
  // Mutable facts read by the residency manager and the effects without re-rendering.
  const live = useRef({ near: false, fullScale: 0, fullBytes: 0, placeholderBytes: 0, textReady: false, scale });
  live.current.scale = scale;

  const priority = useCallback(() => {
    const host = hostRef.current;
    if (!host || !scrollRoot) return Infinity;
    const bounds = host.getBoundingClientRect();
    const viewport = scrollRoot.getBoundingClientRect();
    const distance = Math.abs((bounds.top + bounds.bottom - viewport.top - viewport.bottom) / 2);
    return distance + (bounds.bottom >= viewport.top && bounds.top <= viewport.bottom ? 0 : 100000);
  }, [scrollRoot]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !scrollRoot) return;
    if (typeof IntersectionObserver === "undefined") { live.current.near = true; setNear(true); setInView(true); return; }
    const band = new IntersectionObserver(entries => {
      const entry = entries[entries.length - 1];
      if (!entry) return;
      live.current.near = entry.isIntersecting;
      setNear(entry.isIntersecting);
      residency.touch();
    }, { root: scrollRoot, rootMargin: RENDER_MARGIN });
    const view = new IntersectionObserver(entries => {
      const entry = entries[entries.length - 1];
      if (entry) setInView(entry.isIntersecting);
    }, { root: scrollRoot, rootMargin: TEXT_MARGIN });
    band.observe(host); view.observe(host);
    return () => { band.disconnect(); view.disconnect(); };
  }, [scrollRoot, residency]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    return residency.register({
      number,
      distance: () => {
        if (!scrollRoot) return Infinity;
        const bounds = host.getBoundingClientRect();
        const viewport = scrollRoot.getBoundingClientRect();
        return Math.max(0, bounds.top - viewport.bottom, viewport.top - bounds.bottom);
      },
      near: () => live.current.near,
      pinned: () => selectionCovers(host),
      fullBytes: () => live.current.fullBytes,
      placeholderBytes: () => live.current.placeholderBytes,
      hasText: () => live.current.textReady,
      demote: () => {
        const canvas = canvasRef.current;
        if (!canvas || !canvas.width || !canvas.height) return;
        const width = Math.max(1, Math.round(canvas.width / PLACEHOLDER_DIVISOR));
        const height = Math.max(1, Math.round(canvas.height / PLACEHOLDER_DIVISOR));
        const small = document.createElement('canvas');
        small.width = width; small.height = height;
        const context = small.getContext('2d');
        if (context) context.drawImage(canvas, 0, 0, width, height);
        canvas.width = context ? width : 0; canvas.height = context ? height : 0;
        if (context) canvas.getContext('2d')?.drawImage(small, 0, 0);
        small.width = 0; small.height = 0;
        live.current.fullBytes = 0; live.current.fullScale = 0;
        live.current.placeholderBytes = context ? width * height * 4 : 0;
        setCanvasStatus(context ? 'placeholder' : 'empty');
        if (live.current.near) setCanvasEpoch(value => value + 1);
      },
      evict: () => {
        const canvas = canvasRef.current;
        if (canvas) { canvas.width = 0; canvas.height = 0; }
        live.current.placeholderBytes = 0; live.current.fullBytes = 0; live.current.fullScale = 0;
        setCanvasStatus('empty');
        if (live.current.near) setCanvasEpoch(value => value + 1);
        else doc.cleanupPage(number);
      },
      dropText: () => {
        const layer = textRef.current;
        if (layer) { layer.replaceChildren(); invalidatePdfFigureCache(layer); }
        live.current.textReady = false;
        setTextStatus('none');
        setTextEpoch(value => value + 1);
      },
    });
  }, [residency, number, doc, scrollRoot]);

  // Canvas: render a sharp bitmap for pages in the render band. Leaving the
  // band cancels an unfinished render but keeps whatever is already drawn.
  useEffect(() => {
    if (!near) return;
    if (live.current.fullBytes > 0 && live.current.fullScale === scale) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;
    let renderTask: ReturnType<PDFPageProxy["render"]> | undefined;
    let cancelQueued: (() => void) | undefined;
    const hasBitmap = canvas.width > 0 && canvas.height > 0;
    // Keep the current picture (placeholder or previous zoom) until the new one is complete.
    const target = hasBitmap ? document.createElement('canvas') : canvas;
    setCanvasStatus(hasBitmap ? 'stale' : 'loading');
    const record = tracePage(doc.id, number, scale);
    let finished = false;
    (async () => {
      const page = await doc.pdf.getPage(number);
      if (cancelled) return;
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale });
      setSize({ width: base.width, height: base.height });
      let ratio = Math.min(window.devicePixelRatio || 1, 2);
      if (viewport.width * viewport.height * ratio * ratio > MAX_CANVAS_PIXELS) ratio = Math.max(0.5, Math.sqrt(MAX_CANVAS_PIXELS / (viewport.width * viewport.height)));
      // A cancelled render may still be settling when zoom changes quickly.
      await previousRender.current;
      if (cancelled) return;
      const context = target.getContext("2d");
      if (!context) throw new Error("无法创建页面画布");
      target.width = Math.floor(viewport.width * ratio);
      target.height = Math.floor(viewport.height * ratio);
      renderTask = page.render({ canvasContext: context, viewport, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0] });
      renderTask.onContinue = (continueWork: () => void) => {
        if (cancelled) return;
        cancelQueued = renderQueue.schedule(() => {
          cancelQueued = undefined;
          if (cancelled) return;
          const start = performance.now();
          if (record.canvasFirstSliceMs === undefined) record.canvasFirstSliceMs = Math.round(start - record.startedAt);
          runInThisFrame(continueWork);
          const spent = performance.now() - start;
          record.canvasMainMs += spent; record.canvasSlices++;
          record.canvasMaxSliceMs = Math.max(record.canvasMaxSliceMs, spent);
        }, priority);
      };
      previousRender.current = renderTask.promise.catch(() => {});
      await renderTask.promise;
      if (cancelled) return;
      if (target !== canvas) {
        canvas.width = target.width;
        canvas.height = target.height;
        canvas.getContext('2d')?.drawImage(target, 0, 0);
        target.width = 0; target.height = 0;
      }
      finished = true;
      record.canvasWallMs = Math.round(performance.now() - record.startedAt);
      record.canvasMainMs = Math.round(record.canvasMainMs * 10) / 10;
      live.current.fullScale = scale;
      live.current.fullBytes = canvas.width * canvas.height * 4;
      live.current.placeholderBytes = 0;
      setCanvasStatus('ready');
      residency.touch();
    })().catch(error => {
      if (cancelled || isCancelled(error)) return;
      console.error(`PDF page ${number} failed to render`, error);
      record.error = error instanceof Error ? error.message : String(error);
      setCanvasStatus(hasBitmap ? 'placeholder' : 'error');
    });
    return () => {
      cancelled = true;
      if (!finished) record.canvasCancelled = true;
      cancelQueued?.();
      renderTask?.cancel();
      const release = () => { if (target !== canvas) { target.width = 0; target.height = 0; } };
      if (renderTask) void renderTask.promise.catch(() => {}).then(release); else release();
      if (finished) return;
      if (target === canvas) {
        // A cancelled first render: keep what was drawn as a budgeted
        // placeholder, or clear a canvas that never received any drawing slice.
        if (record.canvasSlices > 0 && canvas.width > 0) {
          live.current.placeholderBytes = canvas.width * canvas.height * 4;
          setCanvasStatus('placeholder');
          residency.touch();
        } else {
          canvas.width = 0; canvas.height = 0;
          setCanvasStatus('empty');
        }
      } else {
        setCanvasStatus(status => status === 'stale' ? (live.current.fullBytes ? 'ready' : 'placeholder') : status);
      }
    };
  }, [doc, number, scale, near, canvasEpoch, renderQueue, priority, residency]);

  // Text: built once per page (zoom only changes --scale-factor), in time
  // slices, for pages about to be read. Leaving the band cancels a partial build.
  useEffect(() => {
    const layer = textRef.current;
    if (!textEnabled || !inView || !layer || live.current.textReady) return;
    const controller = new AbortController();
    let cancelled = false;
    setTextStatus('loading');
    const record = tracePage(doc.id, number, live.current.scale);
    (async () => {
      const { content, cached, ms } = await doc.textContent(number);
      record.textContentMs = Math.round(ms); record.textContentCached = cached; record.textItems = content.items.length;
      if (cancelled) return;
      if (!hasSelectableText(content)) { setTextStatus('empty'); return; }
      const page = await doc.pdf.getPage(number);
      if (cancelled) return;
      layer.replaceChildren();
      invalidatePdfFigureCache(layer);
      layer.dataset.renderGeneration = String(Number(layer.dataset.renderGeneration || 0) + 1);
      const job = createTextLayerJob({
        content, viewport: page.getViewport({ scale: 1 }), container: layer,
        deviceScale: Math.min(window.devicePixelRatio || 1, 2) * live.current.scale, priority,
      });
      let mainMs = 0, maxSlice = 0;
      const started = performance.now();
      await textScheduler.run({
        priority: job.priority,
        run: deadline => {
          const start = performance.now();
          try { return job.run(deadline); }
          finally { const spent = performance.now() - start; mainMs += spent; maxSlice = Math.max(maxSlice, spent); traceTextSlice(spent); }
        },
      }, controller.signal);
      if (cancelled) return;
      Object.assign(record, { textBuildWallMs: Math.round(performance.now() - started), textBuildMainMs: Math.round(mainMs * 10) / 10, textMaxSliceMs: Math.round(maxSlice * 10) / 10, textSpans: job.spans, textChunks: job.chunks });
      live.current.textReady = true;
      invalidatePdfFigureCache(layer);
      setTextStatus('ready');
      residency.touch();
      // Figure hover needs embedded-image boxes; fetch them only for pages
      // that have a caption, after the page is otherwise complete.
      if (content.items.some(item => 'str' in item && FIGURE_CAPTION.test(item.str))) {
        const idle = (window as Window & { requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number }).requestIdleCallback;
        const fetchRects = () => { if (!cancelled) void doc.imageRects(number).catch(() => {}); };
        if (idle) idle(fetchRects, { timeout: 1500 }); else setTimeout(fetchRects, 300);
      }
    })().catch(error => {
      if (cancelled || isCancelled(error)) return;
      console.error(`PDF page ${number} text layer failed`, error);
      record.error = error instanceof Error ? error.message : String(error);
      setTextStatus('error');
    });
    return () => {
      cancelled = true;
      controller.abort();
      if (!live.current.textReady) {
        layer.replaceChildren();
        invalidatePdfFigureCache(layer);
        setTextStatus(status => status === 'loading' ? 'none' : status);
      }
    };
  }, [doc, number, textEnabled, inView, textEpoch, textScheduler, priority, residency]);

  // Links: only for pages about to be read.
  const [links, setLinks] = useState<PdfLink[]>([]);
  useEffect(() => {
    if (!inView) return;
    let cancelled = false;
    doc.links(number).then(value => { if (!cancelled) setLinks(value); }, () => {});
    return () => { cancelled = true; };
  }, [doc, number, inView]);

  // Night mode inverts the page; raster images are inverted back so photos
  // and heat maps keep their real colours.
  const [nightImages, setNightImages] = useState<PdfImageRects | null>(null);
  useEffect(() => {
    if (!night || !near) return;
    let cancelled = false;
    doc.imageRects(number).then(value => { if (!cancelled) setNightImages(value); }, () => {});
    return () => { cancelled = true; };
  }, [doc, number, night, near]);

  // Free bitmaps promptly when the document closes.
  useEffect(() => () => {
    const canvas = canvasRef.current;
    if (canvas) { canvas.width = 0; canvas.height = 0; }
  }, []);

  const renderStatus = canvasStatus === 'error' ? 'error'
    : canvasStatus === 'ready' && (!textEnabled || textStatus === 'ready' || textStatus === 'empty') ? 'ready'
    : (canvasStatus === 'empty' && !near) ? 'waiting' : 'loading';
  return (
    <div
      ref={hostRef}
      className="pr-page"
      data-pdf-page={number}
      data-render-status={renderStatus}
      data-canvas-status={canvasStatus}
      data-text-status={textStatus}
      aria-busy={canvasStatus === 'loading'}
      aria-label={`第 ${number} 页`}
      style={{ width: size.width * scale, height: size.height * scale, "--scale-factor": scale, "--total-scale-factor": scale } as React.CSSProperties}
    >
      <canvas ref={canvasRef} aria-label={`第 ${number} 页的内容`} />
      {night && nightImages && nightImages.rects.length > 0 && canvasStatus !== 'empty' && canvasStatus !== 'loading' && <div className="pr-night-images" aria-hidden="true">
        {nightImages.rects.map((rect, index) => <div key={index} style={{ left: percent(rect.left, nightImages.width), top: percent(rect.top, nightImages.height), width: percent(rect.width, nightImages.width), height: percent(rect.height, nightImages.height) }} />)}
      </div>}
      <div ref={textRef} className="pr-text-layer notranslate" translate="no" />
      {!!searchRects?.length && <div className="pr-search-layer" aria-hidden="true">
        {searchRects.map((rect, index) => <div key={index} className={rect.active ? 'pr-search-hit pr-search-active' : 'pr-search-hit'} style={{ left: `${rect.left}%`, top: `${rect.top}%`, width: `${rect.width}%`, height: `${rect.height}%` }} />)}
      </div>}
      {links.length > 0 && <div className="pr-link-layer">
        {links.map((link, index) => <span key={index} className="pr-link" role="link" tabIndex={-1} aria-label={link.url ? `打开链接 ${link.url}` : '跳转到引用位置'} title={link.url || undefined}
          style={{ left: `${link.left}%`, top: `${link.top}%`, width: `${link.width}%`, height: `${link.height}%` }}
          onClick={event => { event.preventDefault(); onLink(link, 'activate', event.currentTarget); }}
          onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); onLink(link, 'activate', event.currentTarget); } }}
          onPointerEnter={event => onLink(link, 'enter', event.currentTarget)}
          onPointerLeave={event => onLink(link, 'leave', event.currentTarget)} />)}
      </div>}
      {(canvasStatus === "empty" || canvasStatus === "loading") && <span className="pr-page-status">正在加载第 {number} 页…</span>}
      {canvasStatus === "error" && <span className="pr-page-status pr-page-error" role="alert">第 {number} 页加载失败</span>}
      {textStatus === "empty" && canvasStatus === 'ready' && <span className="pr-no-text">此页没有可选文字</span>}
    </div>
  );
});

function tightenFigureToImages(figure: PdfFigure, images: PdfParagraphRect[], x: number, y: number): PdfFigure | null {
  if (figure.kind !== 'figure' || !images.length) return figure;
  const relevant = images.filter(rect => {
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    // Tiny raster symbols (for example fire/snowflake icons inside a vector
    // diagram) must not define the bounds of the whole composite figure.
    return rect.width >= figure.rect.width * 0.18 && rect.height >= 12 &&
      rect.width * rect.height >= figure.rect.width * figure.rect.height * 0.03 &&
      centerX >= figure.rect.left && centerX <= figure.rect.left + figure.rect.width &&
      centerY >= figure.rect.top && centerY <= figure.rect.top + figure.rect.height;
  });
  if (!relevant.length) return figure;
  const top = Math.min(...relevant.map(rect => rect.top));
  // The embedded bitmap is only one part of some composite figures. Use its
  // top edge to exclude title/author prose, but keep the caption-bounded full
  // lane so vector charts and labels beside the bitmap are not cut off.
  const bottom = figure.rect.top + figure.rect.height;
  const left = Math.max(figure.rect.left, Math.min(...relevant.map(rect => rect.left)));
  const right = figure.rect.left + figure.rect.width;
  if (x < left || x > right || y < top || y > bottom) return null;
  return { ...figure, rect: { left, top, width: right - left, height: bottom - top } };
}

function tightenFigureToCanvas(page: HTMLElement, figure: PdfFigure): PdfFigure {
  try {
    const canvas = page.querySelector<HTMLCanvasElement>('canvas');
    if (!canvas || !canvas.width || !canvas.height) return figure;
    const bounds = canvas.getBoundingClientRect();
    const left = Math.max(bounds.left, figure.rect.left);
    const top = Math.max(bounds.top, figure.rect.top);
    const right = Math.min(bounds.right, figure.rect.left + figure.rect.width);
    const bottom = Math.min(bounds.bottom, figure.rect.top + figure.rect.height);
    const scaleX = canvas.width / bounds.width;
    const scaleY = canvas.height / bounds.height;
    const sx = Math.max(0, Math.floor((left - bounds.left) * scaleX));
    const sy = Math.max(0, Math.floor((top - bounds.top) * scaleY));
    const width = Math.min(canvas.width - sx, Math.ceil((right - left) * scaleX));
    const height = Math.min(canvas.height - sy, Math.ceil((bottom - top) * scaleY));
    if (width < 2 || height < 2) return figure;
    const context = canvas.getContext('2d');
    if (!context) return figure;
    const pixels = context.getImageData(sx, sy, width, height).data;
    const rows = new Array<number>(height).fill(0);
    const columns = new Array<number>(width).fill(0);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      // Only remove empty margins. Unlike the discarded dominant-color crop,
      // every sufficiently visible pixel counts, so faint panels stay included.
      if (pixels[offset + 3] > 0 && (pixels[offset] < 250 || pixels[offset + 1] < 250 || pixels[offset + 2] < 250)) { rows[y]++; columns[x]++; }
    }
    const occupiedRows = rows.map((count, index) => count > 0 ? index : -1).filter(index => index >= 0);
    const occupiedColumns = columns.map((count, index) => count > 0 ? index : -1).filter(index => index >= 0);
    if (!occupiedRows.length || !occupiedColumns.length) return figure;
    // Keep a small guard around every visible mark, including thin grey lines.
    const contentLeft = Math.max(left, bounds.left + (sx + occupiedColumns[0]) / scaleX - 2);
    const contentTop = Math.max(top, bounds.top + (sy + occupiedRows[0]) / scaleY - 2);
    const contentRight = Math.min(right, bounds.left + (sx + occupiedColumns[occupiedColumns.length - 1] + 1) / scaleX + 2);
    const contentBottom = Math.min(bottom, bounds.top + (sy + occupiedRows[occupiedRows.length - 1] + 1) / scaleY + 2);
    if (contentRight - contentLeft < 2 || contentBottom - contentTop < 2) return figure;
    return { ...figure, rect: { left: contentLeft, top: contentTop, width: contentRight - contentLeft, height: contentBottom - contentTop } };
  } catch { return figure; }
}

async function capturePdfFigure(page: HTMLElement, figure: PdfFigure, pdf: PDFDocumentProxy, scale: number, signal?: AbortSignal): Promise<Blob | undefined> {
  const canvas = page.querySelector<HTMLCanvasElement>('canvas');
  if (!canvas || !canvas.width || !canvas.height) return undefined;
  const bounds = canvas.getBoundingClientRect();
  const paddingLeft = 4;
  const paddingRight = 4;
  const paddingY = 4;
  const left = Math.max(bounds.left, figure.rect.left - paddingLeft);
  const top = Math.max(bounds.top, figure.rect.top - paddingY);
  const right = Math.min(bounds.right, figure.rect.left + figure.rect.width + paddingRight);
  const bottom = Math.min(bounds.bottom, figure.rect.top + figure.rect.height + paddingY);
  if (right - left < 2 || bottom - top < 2) return undefined;
  const toBlob = (output: HTMLCanvasElement) => new Promise<Blob | undefined>(resolve => output.toBlob(blob => resolve(blob || undefined), 'image/png'));
  // Snapshot crop coordinates above, but let the hover UI paint before rendering.
  await new Promise<void>(resolve => requestAnimationFrame(() => { setTimeout(resolve, 0); }));
  if (signal?.aborted) return undefined;
  try {
    // Re-render the vector/text source at high resolution instead of enlarging
    // the screen canvas. Offset the viewport to the figure's normalized bounds.
    const sourcePage = await pdf.getPage(figure.pageNumber);
    if (signal?.aborted) return undefined;
    // Crop offsets must use the scale-1 viewport. Using the display scale here
    // applies zoom twice and shifts the exported crop at 125%, 150%, etc.
    const baseViewport = sourcePage.getViewport({ scale: 1 });
    const renderScale = Math.min(4, Math.max(scale * 2, 3));
    const x = (left - bounds.left) / bounds.width * baseViewport.width;
    const y = (top - bounds.top) / bounds.height * baseViewport.height;
    const width = (right - left) / bounds.width * baseViewport.width;
    const height = (bottom - top) / bounds.height * baseViewport.height;
    const viewport = sourcePage.getViewport({ scale: renderScale, offsetX: -x * renderScale, offsetY: -y * renderScale });
    const output = document.createElement('canvas');
    output.width = Math.max(1, Math.round(width * renderScale));
    output.height = Math.max(1, Math.round(height * renderScale));
    const context = output.getContext('2d');
    if (!context) return undefined;
    const task = sourcePage.render({ canvasContext: context, viewport });
    const cancel = () => task.cancel();
    signal?.addEventListener('abort', cancel, { once: true });
    try { await task.promise; }
    finally { signal?.removeEventListener('abort', cancel); }
    if (signal?.aborted) return undefined;
    return await toBlob(output);
  } catch {
    if (signal?.aborted) return undefined;
    // A missing renderer or a PDF-specific viewport issue still has the old
    // screen-canvas path as a safe fallback.
    try {
      const scaleX = canvas.width / bounds.width;
      const scaleY = canvas.height / bounds.height;
      const sx = (left - bounds.left) * scaleX;
      const sy = (top - bounds.top) * scaleY;
      const width = (right - left) * scaleX;
      const height = (bottom - top) * scaleY;
      const output = document.createElement('canvas');
      output.width = Math.max(1, Math.round(width));
      output.height = Math.max(1, Math.round(height));
      const context = output.getContext('2d');
      if (!context) return undefined;
      context.drawImage(canvas, sx, sy, width, height, 0, 0, output.width, output.height);
      return await toBlob(output);
    } catch { return undefined; }
  }
}

export function PdfReader(props: PdfReaderProps) {
  // Identity of the *content*, not of the array: a host that passes the same
  // file as a new Uint8Array on re-render must not restart the reader.
  const contentKey = useMemo(() => pdfContentKey(props.data), [props.data]);
  const previousData = useRef<{ data: Uint8Array; key: string } | null>(null);
  if (previousData.current && previousData.current.data !== props.data && previousData.current.key === contentKey) {
    traceEvent('same-content-new-array', { key: contentKey });
  }
  previousData.current = { data: props.data, key: contentKey };
  // A fresh instance prevents the outgoing document's effects and events from
  // writing state for a different document during a rapid switch.
  const instance = useMemo(() => ++nextReaderInstance, [contentKey, props.sessionId, props.workerSrc, props.stateKey]);
  useEffect(() => { traceMount({ instance, key: contentKey, stateKey: props.stateKey }); }, [instance]);
  return <PdfReaderInstance key={instance} instance={instance} contentKey={contentKey} {...props} />;
}

function PdfReaderInstance({ instance, contentKey, data, fileName, sessionId, workerSrc, onAction, enableTextLayer = true, stateKey, statusMessage, onGenerateNotes }: PdfReaderProps & { instance: number; contentKey: string }) {
  // Same tab: in-memory state; otherwise the last position saved for these bytes.
  const initialView = useRef<SavedView>((stateKey !== undefined && readerStates.get(stateKey)) || loadView(contentKey) || { page: 1, scale: 1, fit: true });
  const viewRef = useRef<SavedView>({ ...initialView.current });
  const [fit, setFit] = useState(initialView.current.fit);
  const [prefs, setPrefsState] = useState<ReaderPrefs>(loadPrefs);
  const setPrefs = useCallback((change: Partial<ReaderPrefs>) => setPrefsState(current => { const next = { ...current, ...change }; savePrefs(next); return next; }), []);
  const hoverMenu = prefs.hoverMenu;
  const scaleRef = useRef(initialView.current.scale);
  const zoomAnchor = useRef<{ page: number; fx: number; fy: number; x: number; y: number } | null>(null);
  const [doc, setDoc] = useState<PdfHandle | null>(null);
  const pdf = doc?.pdf ?? null;
  const [error, setError] = useState("");
  const [localStatus, setLocalStatus] = useState("");
  const [scale, setScale] = useState(initialView.current.scale);
  const [pageNumber, setPageNumber] = useState(initialView.current.page);
  const [pageInput, setPageInput] = useState(String(initialView.current.page));
  const [initialSize, setInitialSize] = useState({ width: 612, height: 792 });
  const [scrollRoot, setScrollRoot] = useState<HTMLDivElement | null>(null);
  const [menu, setMenuState] = useState<MenuState | null>(null);
  const menuRef = useRef<MenuState | null>(null);
  const setMenu = useCallback((update: React.SetStateAction<MenuState | null>) => {
    // Pointer frames can arrive between scheduling a React update and commit.
    // Keep the interaction snapshot synchronous so the same target cannot clear
    // a menu that has just opened and start another 180ms timer.
    const next = typeof update === 'function' ? update(menuRef.current) : update;
    if (next === menuRef.current) return;
    menuRef.current = next;
    setMenuState(next);
  }, []);
  const [preparingFigures, setPreparingFigures] = useState(0);
  const [preparingLabel, setPreparingLabel] = useState('正在准备清晰图表…');
  const rootRef = useRef<HTMLDivElement>(null);
  const menuElementRef = useRef<HTMLDivElement>(null);
  const [preparingVisible, setPreparingVisible] = useState(false);
  const [menuPosition, setMenuPosition] = useState<{ left: number; top: number; placement: 'top' | 'bottom' | 'left' | 'right'; orientation: 'horizontal' | 'vertical' } | null>(null);
  const [panel, setPanel] = useState<'outline' | 'display' | null>(null);
  const [outline, setOutline] = useState<PdfOutlineItem[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [activeHit, setActiveHit] = useState(0);
  const [searching, setSearching] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [linkPreview, setLinkPreview] = useState<{ anchor: OverlayRect; title: string; text: string } | null>(null);
  const linkPreviewRef = useRef<HTMLDivElement>(null);
  const previewTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const previewTicket = useRef(0);
  const [returnPoint, setReturnPoint] = useState<{ page: number; offset: number } | null>(null);
  const captures = useRef(new Map<string, CaptureJob>());
  const actionsInFlight = useRef(new Set<string>());
  const renderQueue = useMemo(() => createPdfRenderQueue(), []);
  const textScheduler = useMemo(() => createTaskScheduler({ budgetMs: 6 }), []);
  const residency = useMemo(() => createResidency(), []);
  const dataRef = useRef(data);
  dataRef.current = data;

  const getCapture = useCallback((element: HTMLElement, figure: PdfFigure): CaptureJob | undefined => {
    if (!pdf) return undefined;
    const generation = element.querySelector<HTMLElement>('.pr-text-layer')?.dataset.renderGeneration || '0';
    const bounds = element.querySelector('canvas')?.getBoundingClientRect();
    const crop = [figure.rect.left - (bounds?.left || 0), figure.rect.top - (bounds?.top || 0), figure.rect.width, figure.rect.height]
      .map(value => Math.round(value * 10) / 10).join(':');
    // Include instance in cache key to prevent cross-document cache conflicts
    const key = `${instance}:${figure.pageNumber}:${figure.key}:${scale}:${generation}:${crop}`;
    const cached = captures.current.get(key);
    if (cached && !cached.controller.signal.aborted) {
      captures.current.delete(key); captures.current.set(key, cached);
      return cached;
    }
    for (const [oldKey, job] of captures.current) {
      if (!job.done && !job.claimed) { job.controller.abort(); captures.current.delete(oldKey); }
    }
    const job: CaptureJob = { key, controller: new AbortController(), promise: Promise.resolve(undefined), claimed: false, done: false };
    captures.current.set(key, job);
    job.promise = capturePdfFigure(element, figure, pdf, scale, job.controller.signal).catch(() => undefined).then(blob => {
      job.done = true;
      if (job.controller.signal.aborted) blob = undefined;
      job.blob = blob;
      if (!blob && captures.current.get(key) === job) captures.current.delete(key);
      let done = [...captures.current.values()].filter(item => item.done && item.blob);
      let bytes = done.reduce((sum, item) => sum + (item.blob?.size || 0), 0);
      while (done.length > 4 || bytes > 16 * 1024 * 1024) {
        const oldest = done.shift()!; bytes -= oldest.blob?.size || 0;
        captures.current.delete(oldest.key);
      }
      return blob;
    });
    return job;
  }, [pdf, scale, instance]);

  const showFigure = useCallback((element: HTMLElement, figure: PdfFigure, origin: 'pointer' | 'keyboard' = 'pointer', returnFocus?: HTMLElement | null) => {
    const capture = getCapture(element, figure);
    setMenu({ mode: 'figure', key: figure.key, anchor: figure.rect, origin, returnFocus,
      capture, imageReady: capture?.promise,
      quote: { kind: 'figure', text: figure.caption, pageStart: figure.pageNumber, pageEnd: figure.pageNumber },
      highlights: [{ ...figure.rect }] });
  }, [getCapture]);

  useEffect(() => {
    const job = menu?.capture;
    return () => { if (job && !job.done && !job.claimed) { job.controller.abort(); captures.current.delete(job.key); } };
  }, [menu]);

  useEffect(() => {
    if (!preparingFigures) { setPreparingVisible(false); return; }
    const timer = setTimeout(() => setPreparingVisible(true), 200);
    return () => clearTimeout(timer);
  }, [preparingFigures]);

  useLayoutEffect(() => {
    if (!menu || !scrollRoot || !menuElementRef.current) { setMenuPosition(null); return; }
    const element = menuElementRef.current;
    const bounds = scrollRoot.getBoundingClientRect();
    const viewport = window.visualViewport;
    const left = Math.max(bounds.left, viewport?.offsetLeft || 0);
    const top = Math.max(bounds.top, viewport?.offsetTop || 0);
    const right = Math.min(bounds.right, (viewport?.offsetLeft || 0) + (viewport?.width || window.innerWidth));
    const bottom = Math.min(bounds.bottom, (viewport?.offsetTop || 0) + (viewport?.height || window.innerHeight));
    element.style.maxWidth = `${Math.max(0, right - left - 16)}px`;
    const boundary = { left, top, width: right - left, height: bottom - top };
    // A hover menu sits beside the paragraph (page margin) so it never covers
    // the text being read; without room it falls back to above/below.
    let orientation: 'horizontal' | 'vertical' = menu.mode === 'hover' ? 'vertical' : 'horizontal';
    element.dataset.orientation = orientation;
    let position: { left: number; top: number; placement: 'top' | 'bottom' | 'left' | 'right' } | null = null;
    if (orientation === 'vertical') {
      position = positionMarginOverlay(menu.anchor, { left: left + 2, right: Math.min(right, bounds.left + scrollRoot.clientWidth) - 2 }, boundary, element.getBoundingClientRect());
      if (!position) { orientation = 'horizontal'; element.dataset.orientation = orientation; }
    }
    position ??= positionReaderOverlay(menu.anchor, boundary, element.getBoundingClientRect());
    // Make the measured overlay visible before focusing; hidden elements cannot
    // receive focus during this first layout effect.
    element.style.left = `${position.left}px`; element.style.top = `${position.top}px`; element.style.visibility = 'visible';
    setMenuPosition({ ...position, orientation });
    if (menu.origin === 'keyboard') element.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
  }, [menu, scrollRoot]);

  useEffect(() => {
    if (!scrollRoot) return;
    let initial = true;
    const observer = new ResizeObserver(() => {
      if (initial) { initial = false; return; }
      setMenu(null);
    });
    observer.observe(scrollRoot);
    const close = () => setMenu(null);
    window.addEventListener('resize', close);
    window.visualViewport?.addEventListener('resize', close);
    return () => { observer.disconnect(); window.removeEventListener('resize', close); window.visualViewport?.removeEventListener('resize', close); };
  }, [scrollRoot]);

  useEffect(() => {
    const outside = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!menuElementRef.current?.contains(target)) setMenu(null);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, []);

  const updateView = useCallback((changes: Partial<SavedView>) => {
    viewRef.current = { ...viewRef.current, ...changes };
    if (stateKey !== undefined) readerStates.set(stateKey, viewRef.current);
  }, [stateKey]);

  /** Change zoom while keeping the document point under (x, y) — or the reading line — in place. */
  const applyScale = useCallback((requested: number, point?: { x: number; y: number }) => {
    const next = clampScale(requested);
    if (Math.abs(next - scaleRef.current) < 0.0005 || !scrollRoot) return;
    const bounds = scrollRoot.getBoundingClientRect();
    const x = point?.x ?? bounds.left + scrollRoot.clientWidth / 2;
    const y = point?.y ?? bounds.top + Math.min(scrollRoot.clientHeight * 0.3, 160);
    const pages = scrollRoot.querySelectorAll<HTMLElement>('[data-pdf-page]');
    let anchor: typeof zoomAnchor.current = null;
    for (const page of pages) {
      const rect = page.getBoundingClientRect();
      if (y >= rect.top - 9 && y <= rect.bottom + 9) {
        anchor = { page: Number(page.dataset.pdfPage), fx: (x - rect.left) / rect.width, fy: Math.max(0, Math.min(1, (y - rect.top) / rect.height)), x, y };
        break;
      }
    }
    zoomAnchor.current = anchor;
    scaleRef.current = next;
    updateView({ scale: next });
    setScale(next);
    setMenu(null);
  }, [scrollRoot, updateView]);

  const changeScale = useCallback((delta: number) => {
    setFit(false);
    updateView({ fit: false });
    applyScale(Math.round((scaleRef.current + delta) / SCALE_STEP) * SCALE_STEP || scaleRef.current + delta);
  }, [applyScale, updateView]);

  const toggleFit = useCallback(() => {
    if (fit) { setFit(false); updateView({ fit: false }); applyScale(1); }
    else { setFit(true); updateView({ fit: true }); }
  }, [fit, applyScale, updateView]);

  // Restore the anchored point after a zoom has been laid out.
  useLayoutEffect(() => {
    const anchor = zoomAnchor.current;
    zoomAnchor.current = null;
    if (!anchor || !scrollRoot) return;
    const page = scrollRoot.querySelector<HTMLElement>(`[data-pdf-page="${anchor.page}"]`);
    if (!page) return;
    const rect = page.getBoundingClientRect();
    scrollRoot.scrollTop += rect.top + anchor.fy * rect.height - anchor.y;
    scrollRoot.scrollLeft += rect.left + anchor.fx * rect.width - anchor.x;
  }, [scale, scrollRoot]);

  // Fit width: follow the panel as the host resizes it.
  useEffect(() => {
    if (!fit || !scrollRoot || !doc) return;
    const compute = () => {
      const pages = scrollRoot.querySelector<HTMLElement>('.pr-pages');
      const style = pages ? getComputedStyle(pages) : null;
      const padding = style ? parseFloat(style.paddingLeft) + parseFloat(style.paddingRight) : 48;
      applyScale(fitWidthScale(scrollRoot.clientWidth, initialSize.width, padding, MIN_SCALE, MAX_SCALE), { x: scrollRoot.getBoundingClientRect().left, y: scrollRoot.getBoundingClientRect().top + 16 });
    };
    compute();
    let frame: number | undefined;
    const observer = new ResizeObserver(() => { if (frame === undefined) frame = requestAnimationFrame(() => { frame = undefined; compute(); }); });
    observer.observe(scrollRoot);
    return () => { observer.disconnect(); if (frame !== undefined) cancelAnimationFrame(frame); };
  }, [fit, scrollRoot, doc, initialSize.width, applyScale]);

  // Ctrl/⌘ + wheel and trackpad pinch (a ctrl-wheel in Chromium) zoom at the pointer.
  useEffect(() => {
    if (!scrollRoot) return;
    let factor = 1;
    let point = { x: 0, y: 0 };
    let frame: number | undefined;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      factor *= Math.exp(-Math.max(-50, Math.min(50, event.deltaY)) * 0.01);
      point = { x: event.clientX, y: event.clientY };
      if (frame === undefined) frame = requestAnimationFrame(() => {
        frame = undefined;
        setFit(false); updateView({ fit: false });
        applyScale(scaleRef.current * factor, point);
        factor = 1;
      });
    };
    scrollRoot.addEventListener('wheel', onWheel, { passive: false });
    return () => { scrollRoot.removeEventListener('wheel', onWheel); if (frame !== undefined) cancelAnimationFrame(frame); };
  }, [scrollRoot, applyScale, updateView]);

  // Remember where the reader was, across restarts.
  useEffect(() => {
    if (!doc || !scrollRoot) return;
    const save = () => {
      const page = scrollRoot.querySelector<HTMLElement>(`[data-pdf-page="${viewRef.current.page}"]`);
      let offset: number | undefined;
      if (page) {
        const rect = page.getBoundingClientRect();
        offset = Math.max(0, Math.min(1, (scrollRoot.getBoundingClientRect().top + 16 - rect.top) / rect.height));
      }
      updateView({ offset });
      saveView(contentKey, { page: viewRef.current.page, scale: viewRef.current.scale, fit: viewRef.current.fit, offset });
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => { clearTimeout(timer); timer = setTimeout(save, 600); };
    scrollRoot.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('pagehide', save);
    return () => { clearTimeout(timer); save(); scrollRoot.removeEventListener('scroll', schedule); window.removeEventListener('pagehide', save); };
  }, [doc, scrollRoot, contentKey, updateView]);
  useEffect(() => { if (doc) saveView(contentKey, { ...viewRef.current, fit }); }, [doc, contentKey, fit, scale]);

  useEffect(() => () => {
    captures.current.forEach(job => job.controller.abort());
    captures.current.clear();
    renderQueue.clear();
    textScheduler.clear();
    residency.dispose();
  }, [renderQueue, textScheduler, residency]);

  useEffect(() => {
    let cancelled = false;
    setDoc(null);
    setError("");
    setMenu(null);
    // Reuses an already parsed document with the same bytes (remounts, tab switches).
    const opened = openPdfDocument(dataRef.current, contentKey, workerSrc);
    opened.promise.then(handle => {
      if (cancelled) return;
      setInitialSize(handle.firstPageSize);
      setDoc(handle);
      if (handle.workerMode !== 'thread') setLocalStatus('PDF 正在主线程解析，可能卡顿');
    }, reason => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : "无法打开 PDF 文件");
    });
    return () => {
      cancelled = true;
      const selection = window.getSelection();
      if (selection?.anchorNode && rootRef.current?.contains(selection.anchorNode)) selection.removeAllRanges();
      opened.release();
    };
  }, [contentKey, sessionId, workerSrc]);

  useEffect(() => {
    if (!localStatus) return;
    const timer = setTimeout(() => setLocalStatus(''), 6000);
    return () => clearTimeout(timer);
  }, [localStatus]);

  const copyDiagnostics = useCallback(async () => {
    setLocalStatus('正在采集诊断信息…');
    try { await runProbe(); } catch (reason) { traceEvent('probe-failed', String(reason)); }
    const report = JSON.stringify(buildTraceReport(), null, 2);
    console.info('[dsh-paper-reader] 诊断报告', report);
    try { await navigator.clipboard.writeText(report); setLocalStatus('诊断报告已复制'); }
    catch { setLocalStatus('诊断报告已输出到控制台'); }
  }, []);

  useLayoutEffect(() => {
    if (!pdf || !scrollRoot) return;
    const restoredPage = Math.max(1, Math.min(pdf.numPages, viewRef.current.page));
    const targetPage = scrollRoot.querySelector<HTMLElement>(`[data-pdf-page="${restoredPage}"]`);
    if (targetPage) {
      const rect = targetPage.getBoundingClientRect();
      const within = (viewRef.current.offset ?? 0) * rect.height;
      scrollRoot.scrollTo({ top: scrollRoot.scrollTop + rect.top - scrollRoot.getBoundingClientRect().top - 16 + within, behavior: "auto" });
    }
    updateView({ page: restoredPage });
    setPageNumber(restoredPage);
    setPageInput(String(restoredPage));
    const pages = [...scrollRoot.querySelectorAll<HTMLElement>("[data-pdf-page]")];
    let frame: number | undefined;
    const updatePage = () => {
      frame = undefined;
      const target = scrollRoot.getBoundingClientRect().top + Math.min(scrollRoot.clientHeight * 0.3, 160);
      const current = pages[viewRef.current.page - 1]?.getBoundingClientRect();
      if (current && target >= current.top && target <= current.bottom) return;
      // Pages are ordered vertically. Resolve jumps in O(log pages), while the
      // usual in-page scroll reads only the current page's bounds.
      let low = 0, high = pages.length - 1, closest = -1;
      while (low <= high) {
        const middle = (low + high) >>> 1;
        const bounds = pages[middle].getBoundingClientRect();
        if (target < bounds.top) high = middle - 1;
        else if (target > bounds.bottom) low = middle + 1;
        else { closest = middle; break; }
      }
      if (closest < 0 && pages.length) {
        const before = Math.max(0, high), after = Math.min(pages.length - 1, low);
        closest = Math.abs(pages[before].getBoundingClientRect().bottom - target) <=
          Math.abs(pages[after].getBoundingClientRect().top - target) ? before : after;
      }
      if (closest >= 0 && closest + 1 !== viewRef.current.page) {
        updateView({ page: closest + 1 });
        setPageNumber(closest + 1);
      }
    };
    const schedule = () => { if (frame === undefined) frame = requestAnimationFrame(updatePage); };
    scrollRoot.addEventListener("scroll", schedule, { passive: true });
    return () => { scrollRoot.removeEventListener("scroll", schedule); if (frame !== undefined) cancelAnimationFrame(frame); };
  }, [pdf, scrollRoot, updateView]);

  useEffect(() => { setPageInput(String(pageNumber)); }, [pageNumber]);

  const goToPage = useCallback((requested: number) => {
    if (!pdf || !scrollRoot) return;
    const number = Math.max(1, Math.min(pdf.numPages, Math.round(requested) || 1));
    const target = scrollRoot.querySelector<HTMLElement>(`[data-pdf-page="${number}"]`);
    if (target) scrollRoot.scrollTo({ top: scrollRoot.scrollTop + target.getBoundingClientRect().top - scrollRoot.getBoundingClientRect().top - 16, behavior: "auto" });
    updateView({ page: number });
    setPageNumber(number);
    setPageInput(String(number));
    setMenu(null);
  }, [pdf, scrollRoot, updateView]);

  /** Current reading position (page + fraction), for "back" after a jump. */
  const capturePosition = useCallback(() => {
    const page = viewRef.current.page;
    const element = scrollRoot?.querySelector<HTMLElement>(`[data-pdf-page="${page}"]`);
    if (!element || !scrollRoot) return { page, offset: 0 };
    const rect = element.getBoundingClientRect();
    return { page, offset: Math.max(0, Math.min(1, (scrollRoot.getBoundingClientRect().top + 16 - rect.top) / rect.height)) };
  }, [scrollRoot]);

  /** Scroll so a destination (page + scale-1 px from its top) is at the top of the reader. */
  const goToDestination = useCallback((dest: PdfDestination | { page: number; offset: number }) => {
    if (!scrollRoot) return;
    const element = scrollRoot.querySelector<HTMLElement>(`[data-pdf-page="${dest.page}"]`);
    if (!element) return;
    const rect = element.getBoundingClientRect();
    const within = 'offset' in dest ? dest.offset * rect.height : (dest.top ?? 0) * scaleRef.current;
    scrollRoot.scrollTop += rect.top - scrollRoot.getBoundingClientRect().top - 16 + within;
    setMenu(null);
  }, [scrollRoot]);

  useEffect(() => {
    if (!returnPoint) return;
    const timer = setTimeout(() => setReturnPoint(null), 20000);
    return () => clearTimeout(timer);
  }, [returnPoint]);

  const hidePreview = useCallback(() => { clearTimeout(previewTimer.current); previewTicket.current++; setLinkPreview(null); }, []);
  const onLink = useCallback((link: PdfLink, event: LinkEvent, element: HTMLElement) => {
    if (event === 'leave') { hidePreview(); return; }
    if (event === 'enter') {
      if (link.url || !doc) return;
      clearTimeout(previewTimer.current);
      const ticket = ++previewTicket.current;
      previewTimer.current = setTimeout(async () => {
        const dest = await resolveDestination(doc.pdf, link.dest);
        if (!dest || ticket !== previewTicket.current) return;
        const [{ content }, page] = await Promise.all([doc.textContent(dest.page), doc.pdf.getPage(dest.page)]);
        if (ticket !== previewTicket.current || !element.isConnected) return;
        const text = previewTextAt(content, page.getViewport({ scale: 1 }).transform, dest);
        if (!text) return;
        const rect = element.getBoundingClientRect();
        setLinkPreview({ anchor: { left: rect.left, top: rect.top, width: rect.width, height: rect.height }, title: `第 ${dest.page} 页`, text });
      }, 280);
      return;
    }
    hidePreview();
    if (link.url) { window.open(link.url, '_blank', 'noopener,noreferrer'); return; }
    if (!doc) return;
    void resolveDestination(doc.pdf, link.dest).then(dest => {
      if (!dest) return;
      setReturnPoint(capturePosition());
      goToDestination(dest);
    });
  }, [doc, hidePreview, capturePosition, goToDestination]);

  useLayoutEffect(() => {
    const element = linkPreviewRef.current;
    if (!linkPreview || !element || !scrollRoot) return;
    const bounds = scrollRoot.getBoundingClientRect();
    const position = positionReaderOverlay(linkPreview.anchor, { left: bounds.left, top: bounds.top, width: scrollRoot.clientWidth, height: bounds.height }, element.getBoundingClientRect());
    element.style.left = `${position.left}px`; element.style.top = `${position.top}px`; element.style.visibility = 'visible';
  }, [linkPreview, scrollRoot]);

  useEffect(() => {
    if (!scrollRoot || !linkPreview) return;
    scrollRoot.addEventListener('scroll', hidePreview, { passive: true });
    return () => scrollRoot.removeEventListener('scroll', hidePreview);
  }, [scrollRoot, linkPreview, hidePreview]);

  // Outline (bookmarks) of the document, when it has one.
  useEffect(() => {
    if (!doc) return;
    let cancelled = false;
    doc.outline().then(items => { if (!cancelled) setOutline(items); });
    return () => { cancelled = true; };
  }, [doc]);

  // Close a toolbar popover on outside press or Escape.
  useEffect(() => {
    if (!panel) return;
    const outside = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target?.closest('.pr-popover, [data-panel-toggle]')) setPanel(null);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setPanel(null); };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [panel]);

  // Search over every page's text content (independent of rendered pages).
  useEffect(() => {
    if (!searchOpen || !doc) return;
    const needle = normaliseQuery(query);
    if (!needle) { setHits([]); setSearching(false); return; }
    let cancelled = false;
    const timer = setTimeout(async () => {
      setSearching(true);
      const found: SearchHit[] = [];
      for (let page = 1; page <= doc.numPages; page++) {
        const index = await doc.searchIndex(page).catch(() => null);
        if (cancelled) return;
        if (index) found.push(...searchPageIndex(index, needle));
      }
      if (cancelled) return;
      const first = found.findIndex(hit => hit.page >= viewRef.current.page);
      setHits(found);
      setActiveHit(first < 0 ? 0 : first);
      setSearching(false);
    }, 180);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [query, searchOpen, doc]);

  const searchByPage = useMemo(() => {
    const map = new Map<number, PageSearchRect[]>();
    hits.forEach((hit, index) => {
      const list = map.get(hit.page) || [];
      for (const rect of hit.rects) list.push({ ...rect, active: index === activeHit });
      map.set(hit.page, list);
    });
    return map;
  }, [hits, activeHit]);

  useEffect(() => {
    const hit = hits[activeHit];
    if (!hit || !scrollRoot || !hit.rects.length) return;
    const element = scrollRoot.querySelector<HTMLElement>(`[data-pdf-page="${hit.page}"]`);
    if (!element) return;
    const rect = element.getBoundingClientRect();
    const bounds = scrollRoot.getBoundingClientRect();
    const target = rect.top + hit.rects[0].top / 100 * rect.height;
    if (target < bounds.top + 40 || target > bounds.bottom - 60) scrollRoot.scrollTop += target - (bounds.top + scrollRoot.clientHeight * 0.3);
  }, [activeHit, hits, scrollRoot]);

  useEffect(() => { if (searchOpen) searchInputRef.current?.focus(); }, [searchOpen]);
  const closeSearch = useCallback(() => { setSearchOpen(false); setHits([]); setQuery(''); scrollRoot?.focus({ preventScroll: true }); }, [scrollRoot]);
  const stepHit = useCallback((delta: number) => setActiveHit(index => hits.length ? (index + delta + hits.length) % hits.length : 0), [hits.length]);

  useEffect(() => {
    const updateSelection = () => {
      // A cleared selection may release pinned pages from the memory budget.
      residency.touch();
      const selection = window.getSelection();
      const root = rootRef.current;
      if (!enableTextLayer || !selection || selection.isCollapsed || !selection.rangeCount || !root ||
          !root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) {
        setMenu(null);
        return;
      }
      const inTextLayer = (node: Node | null) => {
        const element = node instanceof Element ? node : node?.parentElement;
        const layer = element?.closest(".pr-text-layer");
        return !!layer && root.contains(layer);
      };
      if (!inTextLayer(selection.anchorNode) || !inTextLayer(selection.focusNode)) { setMenu(null); return; }
      const range = selection.getRangeAt(0);
      const text = selection.toString().trim();
      const pages = Array.from(root.querySelectorAll<HTMLElement>("[data-pdf-page]"))
        .filter((page) => { try { return range.intersectsNode(page.querySelector(".pr-text-layer") || page); } catch { return false; } })
        .map((page) => Number(page.dataset.pdfPage));
      const rect = range.getBoundingClientRect();
      if (!text || !pages.length || (!rect.width && !rect.height)) { setMenu(null); return; }
      setMenu({ mode: 'selection', quote: { text, pageStart: Math.min(...pages), pageEnd: Math.max(...pages) }, anchor: { left: rect.left, top: rect.top, width: rect.width, height: rect.height }, origin: 'pointer' });
    };
    document.addEventListener("selectionchange", updateSelection);
    return () => document.removeEventListener("selectionchange", updateSelection);
  }, [enableTextLayer, pdf, residency]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || !pdf || !enableTextLayer) return;
    return installSelectionGuard(root);
  }, [enableTextLayer, pdf]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || !pdf || !enableTextLayer) return;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    let frame: number | undefined;
    type PointerSample = Pick<PointerEvent, 'target' | 'clientX' | 'clientY' | 'pointerType'>;
    let lastEvent: PointerSample | undefined;
    let scrollIdleTimer: ReturnType<typeof setTimeout> | undefined;
    let scrolling = false;
    const intent = createHoverIntent();
    const clearHoverTimer = () => intent.cancel();
    const clearCloseTimer = () => { if (closeTimer !== undefined) clearTimeout(closeTimer); closeTimer = undefined; };
    const focused = () => !!menuElementRef.current?.contains(document.activeElement);
    const closeSoon = () => {
      if (closeTimer !== undefined || focused()) return;
      closeTimer = setTimeout(() => {
        closeTimer = undefined;
        if (!focused()) setMenu(current => current?.mode === 'selection' ? current : null);
      }, HOVER_CLOSE_DELAY);
    };
    // The dwell belongs to the paragraph, not to the pointer position: moving
    // along a paragraph does not restart it. What is on screen stays until its
    // replacement appears, so crossing paragraphs never blinks.
    const schedule = (key: string, mode: 'hover' | 'figure', activate: (current: () => boolean) => void, immediate = false) => {
      const current = menuRef.current;
      clearCloseTimer();
      if (current?.mode === mode && current.key === key) { clearHoverTimer(); return; }
      intent.request(`${mode}:${key}`, activate, { immediate, warm: current?.mode === 'hover' || current?.mode === 'figure' });
    };
    const processPointer = (event: PointerSample, immediate = false) => {
      if (event.pointerType === 'touch') return;
      let target = event.target instanceof Element ? event.target : null;
      if (!target) return;
      // A citation link covers a few words of the paragraph: hover what is under it.
      if (target.closest('.pr-link')) target = document.elementsFromPoint(event.clientX, event.clientY).find(element => element.matches('.pr-text-layer span')) || target;
      if (target.closest('.pr-selection-menu')) { clearHoverTimer(); clearCloseTimer(); return; }
      if (focused()) { clearHoverTimer(); clearCloseTimer(); return; }
      const current = menuRef.current;
      const floating = menuElementRef.current?.getBoundingClientRect();
      if (current && floating && isPointInOverlayBridge({ x: event.clientX, y: event.clientY }, current.anchor, floating)) {
        clearHoverTimer(); clearCloseTimer(); return;
      }
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed && selection.anchorNode && root.contains(selection.anchorNode)) {
        clearHoverTimer(); clearCloseTimer(); return;
      }
      if (!hoverMenu) { clearHoverTimer(); closeSoon(); return; }
      const pageElement = target.closest<HTMLElement>('[data-pdf-page]');
      if (!pageElement || !root.contains(pageElement) || pageElement.dataset.textStatus !== 'ready') { clearHoverTimer(); closeSoon(); return; }
      const page = Number(pageElement.dataset.pdfPage);
      const layer = pageElement.querySelector<HTMLElement>('.pr-text-layer');
      if (layer) {
        const coarseFigure = findPdfFigureAtPoint(collectPdfFigures(layer, page), event.clientX, event.clientY);
        let clientImages: PdfParagraphRect[] = [];
        if (coarseFigure && doc) {
          const images = doc.imageRectsNow(page);
          const canvasBounds = pageElement.querySelector('canvas')?.getBoundingClientRect();
          if (!images) void doc.imageRects(page).catch(() => {});
          else if (canvasBounds && images.width > 0) {
            const factor = canvasBounds.width / images.width;
            clientImages = images.rects.map(rect => ({ left: canvasBounds.left + rect.left * factor, top: canvasBounds.top + rect.top * factor, width: rect.width * factor, height: rect.height * factor }));
          }
        }
        const figure = coarseFigure ? tightenFigureToImages(coarseFigure, clientImages, event.clientX, event.clientY) : null;
        if (figure) {
          schedule(figure.key, 'figure', isCurrent => {
            const preciseFigure = tightenFigureToCanvas(pageElement, figure);
            const rect = preciseFigure.rect;
            if (event.clientX < rect.left - 4 || event.clientX > rect.left + rect.width + 4 ||
                event.clientY < rect.top - 4 || event.clientY > rect.top + rect.height + 4 || !isCurrent()) return;
            showFigure(pageElement, preciseFigure);
          }, immediate);
          return;
        }
      }
      // Hit-test by position: the gaps between words and lines are still the paragraph.
      const paragraph = layer && !target.closest('button, input, textarea, select') ? findPdfParagraphAt(layer, page, event.clientX, event.clientY) : null;
      if (!paragraph || !paragraph.rects.length) { clearHoverTimer(); closeSoon(); return; }
      schedule(paragraph.key, 'hover', () => {
        const left = Math.min(...paragraph.rects.map(rect => rect.left));
        const right = Math.max(...paragraph.rects.map(rect => rect.right));
        const top = Math.min(...paragraph.rects.map(rect => rect.top));
        const bottom = Math.max(...paragraph.rects.map(rect => rect.bottom));
        setMenu({
          mode: 'hover', key: paragraph.key, origin: 'pointer', math: paragraph.math,
          quote: { text: paragraph.text, pageStart: page, pageEnd: page },
          anchor: { left, top, width: right - left, height: bottom - top },
          highlights: paragraph.rects.map(rect => ({ left: rect.left, top: rect.top, width: rect.width, height: rect.height })),
        });
      }, immediate);
    };
    const onPointerMove = (event: PointerEvent) => {
      lastEvent = event;
      if (scrolling) return;
      if (frame === undefined) frame = requestAnimationFrame(() => { frame = undefined; if (lastEvent) processPointer(lastEvent); });
    };
    const onScroll = () => {
      scrolling = true;
      clearHoverTimer(); clearCloseTimer(); setMenu(null);
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = undefined;
      for (const [key, job] of captures.current) {
        if (!job.done && !job.claimed) { job.controller.abort(); captures.current.delete(key); }
      }
      clearTimeout(scrollIdleTimer);
      scrollIdleTimer = setTimeout(() => {
        scrolling = false;
        if (!lastEvent || lastEvent.pointerType === 'touch') return;
        // Scrolling moves pages under the pointer. Never reuse the old target.
        const target = document.elementFromPoint(lastEvent.clientX, lastEvent.clientY);
        // The pointer has been resting here the whole time: no second dwell.
        if (target && root.contains(target)) processPointer({ target, clientX: lastEvent.clientX, clientY: lastEvent.clientY, pointerType: lastEvent.pointerType }, true);
      }, SCROLL_SETTLE_DELAY);
    };
    const onLeave = () => { lastEvent = undefined; if (frame !== undefined) cancelAnimationFrame(frame); frame = undefined; clearHoverTimer(); closeSoon(); };
    const onFocusIn = () => { if (focused()) clearCloseTimer(); };
    const onFocusOut = (event: FocusEvent) => { if (!menuElementRef.current?.contains(event.relatedTarget as Node | null)) closeSoon(); };
    root.addEventListener('pointermove', onPointerMove);
    root.addEventListener('pointerleave', onLeave);
    root.addEventListener('scroll', onScroll, true);
    root.addEventListener('focusin', onFocusIn);
    root.addEventListener('focusout', onFocusOut);
    return () => {
      clearHoverTimer(); clearCloseTimer(); clearTimeout(scrollIdleTimer); if (frame !== undefined) cancelAnimationFrame(frame);
      root.removeEventListener('pointermove', onPointerMove);
      root.removeEventListener('pointerleave', onLeave);
      root.removeEventListener('scroll', onScroll, true);
      root.removeEventListener('focusin', onFocusIn);
      root.removeEventListener('focusout', onFocusOut);
    };
  }, [enableTextLayer, pdf, doc, scale, showFigure, hoverMenu]);

  const closeMenu = (restoreFocus = false) => {
    const selected = menuRef.current;
    setMenu(null);
    if (restoreFocus) (selected?.returnFocus?.isConnected ? selected.returnFocus : scrollRoot)?.focus({ preventScroll: true });
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    event.currentTarget.dataset.inputMethod = 'keyboard';
    if ((event.ctrlKey || event.metaKey) && event.altKey && event.code === 'KeyD') {
      event.preventDefault();
      void copyDiagnostics();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'f' && pdf) {
      event.preventDefault();
      if (searchOpen) searchInputRef.current?.select(); else setSearchOpen(true);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      closeMenu(true);
      window.getSelection()?.removeAllRanges();
      return;
    }
    const target = event.target as HTMLElement;
    const toolbar = target.closest('.pr-selection-menu');
    if (toolbar && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
      const buttons = [...toolbar.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
      const index = buttons.indexOf(target as HTMLButtonElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 :
        (index + (event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length;
      event.preventDefault(); buttons[next]?.focus(); return;
    }
    if (/^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(target.tagName) || target.isContentEditable || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === 'ArrowRight' || event.key === 'PageDown') { event.preventDefault(); goToPage(pageNumber + 1); }
    else if (event.key === 'ArrowLeft' || event.key === 'PageUp') { event.preventDefault(); goToPage(pageNumber - 1); }
    else if (event.key === '+' || event.key === '=') { event.preventDefault(); changeScale(SCALE_STEP); }
    else if (event.key === '-') { event.preventDefault(); changeScale(-SCALE_STEP); }
  };

  /** Client rectangle of the current selection on one page, for a formula screenshot. */
  const selectionRegion = (): { rect: OverlayRect; page: HTMLElement } | null => {
    const selection = window.getSelection();
    if (!selection?.rangeCount) return null;
    const rects = [...selection.getRangeAt(0).getClientRects()].filter(rect => rect.width > 0 && rect.height > 0);
    if (!rects.length) return null;
    const first = rects[0];
    const page = document.elementsFromPoint(first.left + first.width / 2, first.top + first.height / 2).map(element => element.closest<HTMLElement>('.pr-page')).find(Boolean);
    if (!page) return null;
    const bounds = page.getBoundingClientRect();
    const onPage = rects.filter(rect => rect.top >= bounds.top - 2 && rect.bottom <= bounds.bottom + 2);
    if (onPage.length !== rects.length) return null; // spans pages: text only
    const left = Math.min(...onPage.map(rect => rect.left)), top = Math.min(...onPage.map(rect => rect.top));
    const right = Math.max(...onPage.map(rect => rect.right)), bottom = Math.max(...onPage.map(rect => rect.bottom));
    return { rect: { left, top, width: right - left, height: bottom - top }, page };
  };

  const dispatch = (action: PdfReaderAction) => {
    if (!menu) return;
    const selected = menu;
    const actionKey = `${selected.capture?.key || selected.key}:${action}`;
    if (actionsInFlight.current.has(actionKey)) { closeMenu(selected.origin === 'keyboard'); return; }
    if (selected.capture) selected.capture.claimed = true;
    // Formulas: a model reads the typeset image far better than flattened text.
    const wantsImage = (action === 'explain' || action === 'translate') && selected.mode !== 'figure' && !!pdf &&
      (selected.math || looksLikeMath(selected.quote.text));
    let region: { rect: OverlayRect; page: HTMLElement } | null = null;
    if (wantsImage) {
      if (selected.mode === 'selection') region = selectionRegion();
      else {
        const page = document.elementsFromPoint(selected.anchor.left + 2, selected.anchor.top + 2).map(element => element.closest<HTMLElement>('.pr-page')).find(Boolean);
        if (page) region = { rect: selected.anchor, page };
      }
      if (region && region.rect.height > 640) region = null;
    }
    closeMenu(selected.origin === 'keyboard');
    if (selected.mode === 'figure' && selected.imageReady) {
      actionsInFlight.current.add(actionKey);
      setPreparingLabel('正在准备清晰图表…');
      setPreparingFigures(count => count + 1);
      void selected.imageReady.then(image => {
        if (rootRef.current) onAction(action, { ...selected.quote, image });
      }).finally(() => {
        actionsInFlight.current.delete(actionKey);
        if (rootRef.current) setPreparingFigures(count => Math.max(0, count - 1));
      });
      return;
    }
    // Restore running text: no printed line breaks or soft hyphens.
    const quote: PdfQuote = { ...selected.quote, text: cleanPdfText(selected.quote.text) || selected.quote.text };
    if (region && pdf) {
      const pageNumber = Number(region.page.dataset.pdfPage) || quote.pageStart;
      actionsInFlight.current.add(actionKey);
      setPreparingLabel('正在准备公式截图…');
      setPreparingFigures(count => count + 1);
      void capturePdfFigure(region.page, { key: 'formula', kind: 'figure', pageNumber, caption: quote.text, rect: region.rect, captionRect: region.rect }, pdf, scaleRef.current)
        .catch(() => undefined)
        .then(image => { if (rootRef.current) onAction(action, { ...quote, image }); })
        .finally(() => {
          actionsInFlight.current.delete(actionKey);
          if (rootRef.current) setPreparingFigures(count => Math.max(0, count - 1));
        });
      return;
    }
    onAction(action, quote);
  };

  const zoomPercent = Math.round(scale * 100);
  return (
    <div className="pr-reader" ref={rootRef} onKeyDown={onKeyDown} onPointerDownCapture={event => { event.currentTarget.dataset.inputMethod = 'pointer'; }} data-session-id={sessionId} data-night={prefs.night ? '' : undefined}>
      <div className="pr-toolbar" role="toolbar" aria-label="PDF 阅读工具">
        <div className="pr-title-row">
          <ReaderIcon name="document" />
          <span className="pr-filename" title={fileName}>{fileName}</span>
          {(preparingVisible || statusMessage || localStatus) && <span className="pr-toolbar-status" data-kind={preparingVisible ? 'progress' : 'message'} role="status" title={preparingVisible ? preparingLabel : statusMessage || localStatus}>
            {preparingVisible && <span className="pr-spinner" aria-hidden="true" />}
            <span>{preparingVisible ? preparingLabel : statusMessage || localStatus}</span>
          </span>}
          <div className="pr-tool-group">
            <button type="button" className="pr-tool" aria-label="搜索" title="搜索（Ctrl+F）" aria-pressed={searchOpen} disabled={!pdf} onClick={() => searchOpen ? closeSearch() : setSearchOpen(true)}><ReaderIcon name="search" /></button>
            {outline.length > 0 && <button type="button" className="pr-tool" data-panel-toggle aria-label="目录" title="目录" aria-haspopup="menu" aria-expanded={panel === 'outline'} onClick={() => setPanel(current => current === 'outline' ? null : 'outline')}><ReaderIcon name="outline" /></button>}
            <button type="button" className="pr-tool" data-panel-toggle aria-label="显示设置" title="显示设置" aria-haspopup="dialog" aria-expanded={panel === 'display'} onClick={() => setPanel(current => current === 'display' ? null : 'display')}><ReaderIcon name="display" /></button>
            {onGenerateNotes && <button type="button" className="pr-notes-entry" title="生成阅读笔记" aria-label="生成阅读笔记" onClick={onGenerateNotes}><ReaderIcon name="notes" /><span className="pr-notes-entry-label">笔记</span></button>}
          </div>
        </div>
        <div className="pr-controls">
          <div className="pr-control-group">
            <button type="button" aria-label="上一页" title="上一页" disabled={!pdf || pageNumber <= 1} onClick={() => goToPage(pageNumber - 1)}><ReaderIcon name="previous" /></button>
            <label className="pr-page-input"><span className="pr-sr-only">页码</span><input type="number" min={1} max={pdf?.numPages || 1} value={pageInput} disabled={!pdf} onChange={event => setPageInput(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); goToPage(Number(pageInput)); event.currentTarget.blur(); } }} onBlur={() => goToPage(Number(pageInput))} /></label>
            <span className="pr-page-count">/ {pdf?.numPages || '–'}</span>
            <button type="button" aria-label="下一页" title="下一页" disabled={!pdf || pageNumber >= pdf.numPages} onClick={() => goToPage(pageNumber + 1)}><ReaderIcon name="next" /></button>
          </div>
          <span className="pr-divider" aria-hidden="true" />
          <div className="pr-control-group">
            <button type="button" aria-label="缩小" title="缩小（Ctrl+滚轮）" disabled={!pdf || scale <= MIN_SCALE} onClick={() => changeScale(-SCALE_STEP)}><ReaderIcon name="zoomOut" /></button>
            <button type="button" className="pr-zoom" aria-pressed={fit} disabled={!pdf} aria-label={`缩放 ${zoomPercent}%，${fit ? '已适合宽度，点击切换为 100%' : '点击适合宽度'}`} title={fit ? '已适合宽度（点击切换为 100%）' : '适合宽度'} onClick={toggleFit}>{zoomPercent}%</button>
            <button type="button" aria-label="放大" title="放大（Ctrl+滚轮）" disabled={!pdf || scale >= MAX_SCALE} onClick={() => changeScale(SCALE_STEP)}><ReaderIcon name="zoomIn" /></button>
          </div>
        </div>
        {panel === 'outline' && <div className="pr-popover pr-outline" role="menu" aria-label="目录">
          {outline.map((item, index) => <button key={index} type="button" role="menuitem" style={{ paddingInlineStart: 10 + Math.min(item.depth, 4) * 14 }} data-depth={item.depth} onClick={() => {
            setPanel(null);
            if (!pdf) return;
            void resolveDestination(pdf, item.dest).then(dest => { if (dest) { setReturnPoint(capturePosition()); goToDestination(dest); } });
          }}>{item.title}</button>)}
        </div>}
        {panel === 'display' && <div className="pr-popover pr-display" role="dialog" aria-label="显示设置">
          <label className="pr-switch"><input type="checkbox" checked={prefs.night} onChange={event => setPrefs({ night: event.target.checked })} /><span>夜间阅读</span><small>页面反色，图片保持原色</small></label>
          <label className="pr-switch"><input type="checkbox" checked={prefs.hoverMenu} onChange={event => { setPrefs({ hoverMenu: event.target.checked }); setMenu(null); }} /><span>悬停显示操作</span><small>停在段落或图表上时出现解释、翻译等</small></label>
        </div>}
      </div>
      {searchOpen && <div className="pr-searchbar" role="search">
        <ReaderIcon name="search" />
        <input ref={searchInputRef} type="search" aria-label="在文档中搜索" placeholder="搜索文档" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => {
          if (event.key === 'Enter') { event.preventDefault(); stepHit(event.shiftKey ? -1 : 1); }
          else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeSearch(); }
        }} />
        <span className="pr-search-count" aria-live="polite">{searching ? '搜索中…' : query.trim() ? (hits.length ? `${activeHit + 1} / ${hits.length}` : '无结果') : ''}</span>
        <button type="button" aria-label="上一个结果" title="上一个（Shift+Enter）" disabled={!hits.length} onClick={() => stepHit(-1)}><ReaderIcon name="up" /></button>
        <button type="button" aria-label="下一个结果" title="下一个（Enter）" disabled={!hits.length} onClick={() => stepHit(1)}><ReaderIcon name="down" /></button>
        <button type="button" aria-label="关闭搜索" title="关闭（Esc）" onClick={closeSearch}><ReaderIcon name="close" /></button>
      </div>}
      <div className="pr-scroll" ref={setScrollRoot} tabIndex={0} aria-label="PDF 页面，使用左右方向键切换页面，加减号缩放">
        {error ? <div className="pr-message" role="alert">无法打开 PDF：{error}</div> : !pdf ? <div className="pr-message" role="status">正在打开 PDF…</div> : (
          <div className="pr-pages">{Array.from({ length: pdf.numPages }, (_, index) => <PdfPage key={index + 1} doc={doc!} number={index + 1} scale={scale} textEnabled={enableTextLayer} initialSize={initialSize} scrollRoot={scrollRoot} renderQueue={renderQueue} textScheduler={textScheduler} residency={residency} night={prefs.night} searchRects={searchByPage.get(index + 1)} onLink={onLink} />)}</div>
        )}
      </div>
      {returnPoint && <button type="button" className="pr-return-chip" onClick={() => { const point = returnPoint; setReturnPoint(null); goToDestination(point); }}><ReaderIcon name="back" />返回第 {returnPoint.page} 页</button>}
      {linkPreview && <div ref={linkPreviewRef} className="pr-link-preview" role="tooltip" style={{ visibility: 'hidden' }}><strong>{linkPreview.title}</strong><p>{linkPreview.text}</p></div>}
      {menu?.mode === 'figure' && menu.highlights?.map((rect, index) => <div key={`${menu.key}:${index}`} className="pr-figure-highlight" style={rect} aria-hidden="true" />)}
      {menu?.mode === 'hover' && <div key={menu.key} className="pr-paragraph-outline pr-hover-highlight" style={{ left: menu.anchor.left - 3, top: menu.anchor.top - 2, width: menu.anchor.width + 6, height: menu.anchor.height + 4 }} aria-hidden="true" />}
      {menu && <div ref={menuElementRef} className="pr-selection-menu" data-placement={menuPosition?.placement} data-orientation={menuPosition?.orientation ?? (menu.mode === 'hover' ? 'vertical' : 'horizontal')} role="toolbar" aria-label={menu.mode === 'figure' ? '图表操作' : menu.mode === 'hover' ? '悬停段落的操作' : '选中文字的操作'} aria-orientation={menuPosition?.orientation === 'vertical' ? 'vertical' : 'horizontal'} style={{ left: menuPosition?.left || 0, top: menuPosition?.top || 0, visibility: menuPosition ? 'visible' : 'hidden' }} onMouseDown={(event) => event.preventDefault()}>
        <button type="button" onClick={() => dispatch("explain")}>解释</button>
        {menu.mode !== 'figure' && <><button type="button" onClick={() => dispatch("translate")}>翻译</button><button type="button" onClick={() => dispatch("ask")}>提问</button></>}
        <button type="button" onClick={() => dispatch("copy")}>复制</button>
      </div>}
    </div>
  );
}

export default PdfReader;
