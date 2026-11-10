// Hover feel on a real paper (arXiv 1706.03762): the highlight appears while
// the pointer is still moving, word gaps do not drop it, switching paragraphs
// never blanks, and a display equation is hovered together with its paragraph.
//
//   PAPER_FORMULA_PDF=/path/1706.03762.pdf node tests/hover-timing-e2e.mjs
import http from 'node:http'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { forgetReadingPositions, useActualSize } from './reader-helpers.mjs'

const pdfPath = process.env.PAPER_FORMULA_PDF
if (!pdfPath) throw new Error('Set PAPER_FORMULA_PDF (arXiv 1706.03762)')
const harness = await build({ entryPoints: ['tests/browser-harness.jsx'], bundle: true, write: false, platform: 'browser', jsx: 'automatic', format: 'iife' })
const html = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>html,body{height:100%;margin:0}#app{width:760px;height:100%;float:right}#draft,#open-result{display:none}</style></head><body><pre id="draft"></pre><span id="open-result"></span><div id="app"></div><script src="/harness.js"></script><script src="/client.js"></script><script>startHarness().catch(e=>document.body.append(String(e)))</script></body></html>'
const pdf = await readFile(pdfPath), client = await readFile('lib/client.js')
const server = http.createServer((req, res) => {
  const route = { '/': [html, 'text/html; charset=utf-8'], '/harness.js': [harness.outputFiles[0].contents, 'text/javascript'], '/client.js': [client, 'text/javascript'], '/paper.pdf': [pdf, 'application/pdf'] }[new URL(req.url, 'http://x').pathname]
  if (!route) { res.writeHead(404).end(); return }
  res.writeHead(200, { 'Content-Type': route[1], 'Cache-Control': 'no-store' }); res.end(route[0])
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  await forgetReadingPositions(page)
  await page.goto(`http://127.0.0.1:${server.address().port}/`)
  await page.locator('[data-pdf-page="1"][data-render-status="ready"]').waitFor({ timeout: 30000 })
  await useActualSize(page)
  const span = async (number, text) => {
    const locator = page.locator(`[data-pdf-page="${number}"] .pr-text-layer span`).filter({ hasText: text }).first()
    await locator.waitFor({ timeout: 30000 })
    return locator
  }
  const goto = async number => {
    await page.evaluate(n => { const scroll = document.querySelector('.pr-scroll'); scroll.scrollTop = document.querySelector(`[data-pdf-page="${n}"]`).offsetTop - 16 }, number)
    await page.locator(`[data-pdf-page="${number}"][data-text-status="ready"]`).waitFor({ timeout: 30000 })
    await page.waitForTimeout(400)
  }
  const outline = () => page.evaluate(() => { const box = document.querySelector('.pr-paragraph-outline')?.getBoundingClientRect(); return box ? { left: box.left, top: box.top, right: box.right, bottom: box.bottom } : null })

  // 1. Equation (1) on page 4 is hovered together with the sentence that introduces it.
  await goto(4)
  const intro = await (await span(4, 'the matrix of outputs as:')).boundingBox()
  const equation = await (await span(4, 'Attention(')).boundingBox()
  await page.mouse.move(intro.x + 10, intro.y + intro.height / 2)
  await page.locator('.pr-paragraph-outline').waitFor({ timeout: 2000 })
  let box = await outline()
  assert.ok(box.top <= intro.y + 1 && box.bottom >= equation.y + equation.height - 1, 'paragraph outline covers its display equation')
  // …and from the equation itself, including the white space beside it.
  await page.mouse.move(5, 5); await page.locator('.pr-paragraph-outline').waitFor({ state: 'detached', timeout: 2000 })
  await page.mouse.move(equation.x - 60, equation.y + equation.height / 2)
  await page.locator('.pr-paragraph-outline').waitFor({ timeout: 2000 })
  box = await outline()
  assert.ok(box.top <= intro.y + 1 && box.bottom >= equation.y + equation.height - 1, 'hovering beside the equation selects the same paragraph')

  // 2. The highlight appears while the pointer keeps moving along a line.
  await page.mouse.move(5, 5); await page.locator('.pr-paragraph-outline').waitFor({ state: 'detached', timeout: 2000 })
  const line = await (await span(4, 'The two most commonly used attention functions')).boundingBox()
  const y = line.y + line.height / 2
  await page.mouse.move(line.x + 4, y)
  const started = Date.now()
  let shownAfter
  for (let step = 1; step <= 40 && shownAfter === undefined; step++) {
    await page.mouse.move(line.x + 4 + step * 6, y)
    await page.waitForTimeout(8)
    if (await page.locator('.pr-paragraph-outline').count()) shownAfter = Date.now() - started
  }
  assert.ok(shownAfter !== undefined, 'highlight appeared during continuous movement')

  // 3. Crossing into the next paragraph swaps the highlight without a blank frame.
  await page.evaluate(() => {
    window.outlineGaps = 0
    new MutationObserver(() => { if (!document.querySelector('.pr-paragraph-outline')) window.outlineGaps++ }).observe(document.querySelector('.pr-shell') || document.body, { childList: true, subtree: true })
  })
  const before = await outline()
  const next = await (await span(4, 'While for small values of')).boundingBox()
  for (let step = 0; step <= 12; step++) { await page.mouse.move(line.x + 120, y + (next.y + next.height / 2 - y) * step / 12); await page.waitForTimeout(12) }
  await page.waitForFunction(top => { const box = document.querySelector('.pr-paragraph-outline')?.getBoundingClientRect(); return box && Math.abs(box.top - top) > 4 }, before.top, { timeout: 2000 })
  assert.equal(await page.evaluate(() => window.outlineGaps), 0, 'no blank frame between paragraphs')
  console.log(JSON.stringify({ status: 'passed', equationWithParagraph: true, hoverBesideEquation: true, shownWhileMovingMs: shownAfter, seamlessSwitch: true }))
} finally { await browser.close(); server.close() }
