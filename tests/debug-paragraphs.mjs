// Print the hover paragraphs the reader recognises on given pages.
//
//   node tests/debug-paragraphs.mjs /path/paper.pdf 4 [5 ...]
// Env: CHROME_PATH, DUMP_JSON=/path/out.json (raw fragments per page)
import http from 'node:http'
import { readFile, writeFile } from 'node:fs/promises'
import { build } from 'esbuild'
import ts from 'typescript'
import { chromium } from 'playwright-core'
import { forgetReadingPositions, useActualSize } from './reader-helpers.mjs'

const [pdfPath, ...pageArgs] = process.argv.slice(2)
if (!pdfPath || !pageArgs.length) throw new Error('usage: debug-paragraphs.mjs paper.pdf page [page ...]')
const source = await readFile(new URL('../src/paragraphs.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } })
const paragraphs = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputText).toString('base64')}`)

const harness = await build({ entryPoints: ['tests/browser-harness.jsx'], bundle: true, write: false, platform: 'browser', jsx: 'automatic', format: 'iife' })
const html = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>html,body{height:100%;margin:0}#app{width:760px;height:100%;float:right}#draft,#open-result{display:none}</style></head><body><pre id="draft"></pre><span id="open-result"></span><div id="app"></div><script src="/harness.js"></script><script src="/client.js"></script><script>startHarness().catch(e=>document.body.append(String(e)))</script></body></html>'
const pdf = await readFile(pdfPath)
const client = await readFile('lib/client.js')
const server = http.createServer((req, res) => {
  const route = { '/': [html, 'text/html; charset=utf-8'], '/harness.js': [harness.outputFiles[0].contents, 'text/javascript'], '/client.js': [client, 'text/javascript'], '/paper.pdf': [pdf, 'application/pdf'] }[new URL(req.url, 'http://x').pathname]
  if (!route) { res.writeHead(404).end(); return }
  res.writeHead(200, { 'Content-Type': route[1], 'Cache-Control': 'no-store' }); res.end(route[0])
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
const dump = {}
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  await forgetReadingPositions(page)
  await page.goto(`http://127.0.0.1:${server.address().port}/`)
  await page.locator('[data-pdf-page="1"][data-render-status="ready"]').waitFor({ timeout: 30000 })
  await useActualSize(page)
  for (const number of pageArgs.map(Number)) {
    await page.evaluate(n => { const scroll = document.querySelector('.pr-scroll'); scroll.scrollTop = document.querySelector(`[data-pdf-page="${n}"]`).offsetTop - 16 }, number)
    await page.locator(`[data-pdf-page="${number}"][data-text-status="ready"]`).waitFor({ timeout: 30000 })
    const fragments = await page.evaluate(n => {
      const layer = document.querySelector(`[data-pdf-page="${n}"] .pr-text-layer`)
      const origin = layer.getBoundingClientRect()
      return [...layer.querySelectorAll('span')].filter(element => element.textContent.trim() && !element.querySelector('span') && !element.closest('.markedContent')).map(element => {
        const rect = element.getBoundingClientRect()
        return { text: element.textContent, rect: { left: rect.left - origin.left, top: rect.top - origin.top, width: rect.width, height: rect.height }, fontSize: parseFloat(getComputedStyle(element).fontSize) }
      }).filter(fragment => fragment.rect.width && fragment.rect.height).map((fragment, order) => ({ ...fragment, order }))
    }, number)
    dump[number] = fragments
    const recognise = paragraphs.recognisePdfParagraphs || (input => paragraphs.groupPdfVisualLines(paragraphs.attachPdfScripts(paragraphs.buildPdfVisualLines(input))))
    const groups = recognise(fragments)
    console.log(`\n===== page ${number}: ${groups.length} paragraphs =====`)
    for (const lines of groups) {
      const left = Math.min(...lines.map(line => line.rect.left)), top = lines[0].rect.top
      console.log(`--- [${lines.length} lines, x=${left.toFixed(0)} y=${top.toFixed(0)}${lines.some(line => line.math) ? ', math' : ''}]`)
      for (const line of lines) console.log(`   ${line.math ? 'ƒ' : ' '} ${line.rect.left.toFixed(0).padStart(4)} ${line.rect.top.toFixed(0).padStart(4)} w${line.rect.width.toFixed(0).padStart(4)} f${line.fontSize.toFixed(1)} | ${line.text.slice(0, 110)}`)
    }
  }
  if (process.env.DUMP_JSON) await writeFile(process.env.DUMP_JSON, JSON.stringify(dump))
} finally { await browser.close(); server.close() }
