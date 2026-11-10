/**
 * Always-on, low-overhead diagnostics for real-host acceptance.
 *
 * In the DSH devtools console:
 *   await __dshPaperReaderProbe()        // 2 s environment probe, then report
 *   copy(JSON.stringify(__dshPaperReaderTrace(), null, 2))
 * Or press Ctrl+Alt+D inside the reader: runs the probe and copies the report.
 *
 * Unsupported browser metrics are reported as `supported: false`, never
 * silently omitted, so an empty list really means "nothing was observed".
 */
import { hostHasMainThreadPdfWorker } from './pdfWorker';

export interface PageTrace {
  doc: number;
  page: number;
  scale: number;
  startedAt: number;
  /** Wall time from request to finished bitmap, including waiting for the worker and frames. */
  canvasWallMs?: number;
  /** Main-thread time spent inside pdf.js drawing slices. */
  canvasMainMs: number;
  canvasSlices: number;
  canvasMaxSliceMs: number;
  /** Time to first slice: mostly waiting for the worker's operator list and fonts. */
  canvasFirstSliceMs?: number;
  canvasCancelled?: boolean;
  textContentMs?: number;
  textContentCached?: boolean;
  textItems?: number;
  textSpans?: number;
  textChunks?: number;
  textBuildWallMs?: number;
  textBuildMainMs?: number;
  textMaxSliceMs?: number;
  error?: string;
}

type LongTask = { start: number; duration: number; name?: string; scripts?: Array<{ source: string; fn: string; invoker: string; ms: number }> };

const MAX_PAGES = 400;
const MAX_TASKS = 300;
const state = {
  loadedAt: Date.now(),
  hostHadMainThreadPdfWorkerAtLoad: false,
  worker: undefined as undefined | { mode: string; reason?: string; startupMs: number },
  opens: [] as Array<Record<string, unknown>>,
  mounts: [] as Array<Record<string, unknown>>,
  pages: [] as PageTrace[],
  longTasks: [] as LongTask[],
  longFrames: [] as LongTask[],
  longTaskSupported: false,
  longFrameSupported: false,
  textSlices: { count: 0, totalMs: 0, maxMs: 0 },
  probe: undefined as undefined | Record<string, unknown>,
  events: [] as Array<{ at: number; event: string; detail?: unknown }>,
};
let observers: PerformanceObserver[] = [];
let installed = false;

const round = (value: number) => Math.round(value * 10) / 10;

export function installTrace() {
  if (installed) return;
  installed = true;
  state.hostHadMainThreadPdfWorkerAtLoad = hostHasMainThreadPdfWorker();
  try {
    const observer = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        if (state.longTasks.length >= MAX_TASKS) state.longTasks.shift();
        const attribution = (entry as PerformanceEntry & { attribution?: Array<{ containerType?: string; containerName?: string; containerSrc?: string }> }).attribution?.[0];
        state.longTasks.push({ start: round(entry.startTime), duration: round(entry.duration), name: attribution ? `${attribution.containerType || ''} ${attribution.containerName || attribution.containerSrc || ''}`.trim() : entry.name });
      }
    });
    observer.observe({ type: 'longtask', buffered: true });
    observers.push(observer);
    state.longTaskSupported = true;
  } catch { state.longTaskSupported = false; }
  try {
    // Long Animation Frames name the script (host, plugin or extension) that blocked.
    const observer = new PerformanceObserver(list => {
      for (const entry of list.getEntries() as Array<PerformanceEntry & { blockingDuration?: number; scripts?: Array<{ sourceURL?: string; sourceFunctionName?: string; invoker?: string; duration: number }> }>) {
        if (entry.duration < 150) continue;
        if (state.longFrames.length >= MAX_TASKS) state.longFrames.shift();
        state.longFrames.push({
          start: round(entry.startTime), duration: round(entry.duration),
          scripts: (entry.scripts || []).slice().sort((a, b) => b.duration - a.duration).slice(0, 4).map(script => ({
            source: (script.sourceURL || '').slice(0, 160), fn: (script.sourceFunctionName || '').slice(0, 80), invoker: (script.invoker || '').slice(0, 80), ms: round(script.duration),
          })),
        });
      }
    });
    observer.observe({ type: 'long-animation-frame', buffered: true });
    observers.push(observer);
    state.longFrameSupported = true;
  } catch { state.longFrameSupported = false; }
  const target = window as unknown as Record<string, unknown>;
  target.__dshPaperReaderTrace = buildTraceReport;
  target.__dshPaperReaderProbe = async () => { await runProbe(); return buildTraceReport(); };
}

export function uninstallTrace() {
  observers.forEach(observer => observer.disconnect());
  observers = [];
  installed = false;
  const target = window as unknown as Record<string, unknown>;
  delete target.__dshPaperReaderTrace;
  delete target.__dshPaperReaderProbe;
}

export function traceEvent(event: string, detail?: unknown) {
  if (state.events.length >= 200) state.events.shift();
  state.events.push({ at: round(performance.now()), event, detail });
}
export function traceWorker(result: { mode: string; reason?: string; startupMs: number }) {
  state.worker = { mode: result.mode, reason: result.reason, startupMs: round(result.startupMs) };
}
export function traceOpen(record: Record<string, unknown>) {
  if (state.opens.length >= 100) state.opens.shift();
  state.opens.push({ at: round(performance.now()), ...record });
}
export function traceMount(record: Record<string, unknown>) {
  if (state.mounts.length >= 100) state.mounts.shift();
  state.mounts.push({ at: round(performance.now()), ...record });
}
export function tracePage(doc: number, page: number, scale: number): PageTrace {
  const record: PageTrace = { doc, page, scale, startedAt: round(performance.now()), canvasMainMs: 0, canvasSlices: 0, canvasMaxSliceMs: 0 };
  if (state.pages.length >= MAX_PAGES) state.pages.shift();
  state.pages.push(record);
  return record;
}
export function traceTextSlice(ms: number) {
  state.textSlices.count++;
  state.textSlices.totalMs += ms;
  state.textSlices.maxMs = Math.max(state.textSlices.maxMs, ms);
}

function nativeApiReport() {
  const isNative = (fn: unknown) => {
    try { return typeof fn === 'function' && /\{\s*\[native code\]\s*\}\s*$/.test(Function.prototype.toString.call(fn)); }
    catch { return false; }
  };
  const fontSetter = Object.getOwnPropertyDescriptor(CanvasRenderingContext2D.prototype, 'font')?.set;
  const apis: Record<string, unknown> = {
    'document.createElement': Document.prototype.createElement,
    'Node.appendChild': Node.prototype.appendChild,
    'Node.insertBefore': Node.prototype.insertBefore,
    'Element.append': Element.prototype.append,
    'Element.setAttribute': Element.prototype.setAttribute,
    'Element.getBoundingClientRect': Element.prototype.getBoundingClientRect,
    'EventTarget.addEventListener': EventTarget.prototype.addEventListener,
    requestAnimationFrame: window.requestAnimationFrame,
    setTimeout: window.setTimeout,
    MutationObserver: window.MutationObserver,
    Promise: window.Promise,
    Worker: window.Worker,
    'CanvasRenderingContext2D.font(set)': fontSetter,
    'CanvasRenderingContext2D.drawImage': CanvasRenderingContext2D.prototype.drawImage,
    'FontFaceSet.add': (document.fonts as unknown as { add?: unknown })?.add,
  };
  return Object.keys(apis).filter(name => !isNative(apis[name]));
}

const nextTask = () => new Promise<void>(resolve => { const channel = new MessageChannel(); channel.port1.onmessage = () => resolve(); channel.port2.postMessage(null); });

/**
 * Measures the host itself: frame rate, event-loop latency and the cost of
 * inserting text spans live (the pdf.js pattern) versus detached-then-once.
 */
export async function runProbe(): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = { at: round(performance.now()) };
  // Frame rate over one second; a throttled host shows far below 60.
  result.framesPerSecond = await new Promise<number>(resolve => {
    let frames = 0; const start = performance.now();
    const tick = () => { frames++; if (performance.now() - start < 1000) requestAnimationFrame(tick); else resolve(round(frames * 1000 / (performance.now() - start))); };
    requestAnimationFrame(tick);
    setTimeout(() => resolve(frames), 3000);
  });
  // Event-loop latency: time for 20 consecutive macrotask hops.
  {
    const start = performance.now();
    for (let index = 0; index < 20; index++) await nextTask();
    result.taskHopMs = round((performance.now() - start) / 20);
  }
  const host = document.querySelector<HTMLElement>('.pr-page') || document.querySelector<HTMLElement>('.pr-reader');
  if (host) {
    const make = () => { const layer = document.createElement('div'); layer.className = 'pr-text-layer'; layer.style.visibility = 'hidden'; layer.setAttribute('aria-hidden', 'true'); return layer; };
    const span = (index: number) => { const element = document.createElement('span'); element.textContent = `probe ${index} text`; element.style.left = `${index % 90}%`; element.style.top = `${(index * 7) % 95}%`; element.style.fontSize = `calc(var(--scale-factor)*${9 + (index % 3)}px)`; return element; };
    const count = 300;
    // Detached build, one insertion.
    let layer = make(); host.appendChild(layer); layer.getBoundingClientRect();
    let start = performance.now();
    const chunk = document.createDocumentFragment();
    for (let index = 0; index < count; index++) chunk.appendChild(span(index));
    layer.appendChild(chunk); layer.getBoundingClientRect();
    result.detachedInsert300Ms = round(performance.now() - start);
    layer.remove();
    // Live insertion with a body-attached canvas font change per span (pdf.js 4.10 TextLayer pattern).
    layer = make(); host.appendChild(layer); layer.getBoundingClientRect();
    const canvas = document.createElement('canvas'); canvas.style.display = 'none'; document.body.appendChild(canvas);
    const context = canvas.getContext('2d');
    start = performance.now();
    for (let index = 0; index < count; index++) {
      layer.appendChild(span(index));
      if (context) { context.font = `${10 + (index % 2)}px sans-serif`; context.measureText('probe'); }
    }
    layer.getBoundingClientRect();
    result.liveInsert300Ms = round(performance.now() - start);
    layer.remove(); canvas.remove();
    // Pure element creation, never attached: isolates patched DOM APIs.
    start = performance.now();
    const loose = document.createElement('div');
    for (let index = 0; index < count; index++) loose.appendChild(span(index));
    result.createOnly300Ms = round(performance.now() - start);
  }
  state.probe = result;
  return result;
}

export function buildTraceReport() {
  const pages = state.pages.map(page => ({ ...page }));
  const sum = (values: Array<number | undefined>) => round(values.reduce<number>((total, value) => total + (value || 0), 0));
  return {
    plugin: 'dsh-paper-reader',
    version: '0.7.1',
    generatedAt: new Date().toISOString(),
    uptimeMs: Date.now() - state.loadedAt,
    environment: {
      userAgent: navigator.userAgent,
      devicePixelRatio: window.devicePixelRatio,
      hardwareConcurrency: navigator.hardwareConcurrency,
      deviceMemory: (navigator as Navigator & { deviceMemory?: number }).deviceMemory,
      location: `${location.protocol}//${location.host}`,
      crossOriginIsolated: window.crossOriginIsolated,
      hostDomElements: document.getElementsByTagName('*').length,
      fontFaces: document.fonts?.size,
      hostHadMainThreadPdfWorkerAtLoad: state.hostHadMainThreadPdfWorkerAtLoad,
      hostHasMainThreadPdfWorkerNow: hostHasMainThreadPdfWorker(),
      patchedApis: nativeApiReport(),
      offscreenCanvas: typeof OffscreenCanvas !== 'undefined',
    },
    worker: state.worker || { mode: 'not-started' },
    opens: state.opens,
    mounts: state.mounts,
    summary: {
      pagesTraced: pages.length,
      canvasMainMsTotal: sum(pages.map(page => page.canvasMainMs)),
      canvasMaxSliceMs: round(Math.max(0, ...pages.map(page => page.canvasMaxSliceMs))),
      textBuildMainMsTotal: sum(pages.map(page => page.textBuildMainMs)),
      textMaxSliceMs: round(state.textSlices.maxMs),
      textSlices: state.textSlices.count,
      longTasks: { supported: state.longTaskSupported, count: state.longTasks.length, totalMs: sum(state.longTasks.map(task => task.duration)), maxMs: round(Math.max(0, ...state.longTasks.map(task => task.duration))) },
      longAnimationFrames: { supported: state.longFrameSupported, countOver150ms: state.longFrames.length },
    },
    probe: state.probe || null,
    pages,
    longTasks: state.longTasks.slice(-80),
    longAnimationFrames: state.longFrames.slice(-40),
    events: state.events.slice(-80),
  };
}
