import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright-core'
import { forgetReadingPositions, useActualSize } from './reader-helpers.mjs'

const url = process.env.PAPER_TEST_URL
const pdf = process.env.PAPER_TEST_PDF
if (!url || !pdf) throw new Error('Set PAPER_TEST_URL and PAPER_TEST_PDF')
const executablePath = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const browser = await chromium.launch({ executablePath, headless: true })
try {
  const page = await browser.newPage()
  await forgetReadingPositions(page)
  const errors = []
  page.on('pageerror', error => errors.push(String(error)))
  await page.goto(url, { waitUntil: 'networkidle' })
  await useActualSize(page)
  const title = page.locator('[data-pdf-page="1"] .pr-text-layer span').filter({ hasText: 'SuperMimic:' }).first()
  await title.waitFor({ timeout: 20000 })
  assert.equal(await page.locator('[data-pdf-page]').count(), 19)

  const selectTitle = async () => {
    await title.evaluate(node => {
      const range = document.createRange()
      range.selectNodeContents(node)
      const selection = window.getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
      document.dispatchEvent(new Event('selectionchange'))
    })
    await page.locator('.pr-selection-menu').waitFor()
  }
  await selectTitle()
  await page.locator('.pr-selection-menu button').first().click()
  await page.waitForFunction(() => window.testHarness.sentMessages.length === 1)
  const draft = await page.evaluate(() => window.testHarness.sentMessages[0].text)
  assert.match(draft, /来源：SuperMimic\.pdf，第 1 页/)
  assert.match(draft, /SuperMimic: Scaling Humanoid Whole-Body Control/)

  const figureCaption = page.locator('[data-pdf-page="1"] .pr-text-layer span').filter({ hasText: 'Figure 1:' }).first()
  await figureCaption.waitFor()
  const figureBox = await figureCaption.boundingBox()
  assert.ok(figureBox)
  await page.evaluate(() => {
    window.getSelection()?.removeAllRanges()
    const original = HTMLCanvasElement.prototype.toBlob
    window.pendingFigureEncodes = []
    window.releaseFigureEncodes = () => {
      HTMLCanvasElement.prototype.toBlob = original
      for (const release of window.pendingFigureEncodes.splice(0)) release()
    }
    HTMLCanvasElement.prototype.toBlob = function (callback, ...args) {
      original.call(this, blob => window.pendingFigureEncodes.push(() => callback(blob)), ...args)
    }
  })
  await page.mouse.move(figureBox.x + figureBox.width / 2, figureBox.y - 80)
  await page.getByRole('toolbar', { name: '图表操作' }).waitFor({ timeout: 5000 })
  assert.equal(await page.locator('.pr-selection-menu button').count(), 2)
  await page.waitForFunction(() => window.pendingFigureEncodes.length > 0)
  assert.equal(await page.locator('.pr-figure-highlight').isVisible(), true, 'figure highlight is visible before PNG encoding completes')
  assert.equal(await page.getByRole('toolbar', { name: '图表操作' }).isVisible(), true, 'figure actions do not wait for image encoding')
  await mkdir('test-results', { recursive: true })
  await page.screenshot({ path: 'test-results/figure-hover.png' })
  const figureMenuBox = await page.locator('.pr-selection-menu').boundingBox()
  assert.ok(figureMenuBox)
  // A short slip off the figure and back keeps the menu (it closes ~0.3s after leaving).
  await page.mouse.move(10, figureMenuBox.y + figureMenuBox.height + 20)
  await page.waitForTimeout(150)
  await page.mouse.move(figureMenuBox.x + figureMenuBox.width / 2, figureMenuBox.y + figureMenuBox.height / 2)
  await page.getByRole('toolbar', { name: '图表操作' }).waitFor({ state: 'visible' })
  await page.locator('.pr-selection-menu button').first().click()
  await page.getByRole('status').filter({ hasText: '正在准备清晰图表' }).waitFor()
  assert.equal(await page.evaluate(() => window.testHarness.sentMessages.length), 1, 'early clicks wait for the captured image')
  await page.evaluate(() => window.releaseFigureEncodes())
  await page.waitForFunction(() => window.testHarness.sentMessages.length === 2)
  await page.getByRole('status').filter({ hasText: '正在准备清晰图表' }).waitFor({ state: 'hidden' })
  const figureDataUrl = await page.evaluate(async () => {
    const file = window.testHarness.sentMessages[1].files[0]
    return await new Promise(resolve => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.readAsDataURL(file) })
  })
  await writeFile('test-results/figure.png', Buffer.from(figureDataUrl.split(',')[1], 'base64'))
  assert.ok((await page.evaluate(() => window.testHarness.sentMessages[1].files[0].size)) > 1000)
  assert.equal(await page.evaluate(() => window.testHarness.sentMessages.at(-1).text), '解释这张图表')

  await page.evaluate(() => window.getSelection()?.removeAllRanges())
  await page.getByRole('button', { name: '下一页' }).click()
  const hoverLine = page.locator('[data-pdf-page="2"] .pr-text-layer span').filter({ hasText: 'SuperMimic addresses this inefficiency' }).first()
  const assertAligned = async () => {
    await page.locator('.pr-hover-highlight').first().waitFor()
    const line = await hoverLine.boundingBox()
    const highlight = await page.locator('.pr-hover-highlight').first().boundingBox()
    assert.ok(line && highlight)
    assert.ok(Math.abs(line.x - highlight.x - 3) < 1 && Math.abs(line.y - highlight.y - 2) < 1, `paragraph surface must enclose text with its safety padding: ${JSON.stringify({ line, highlight })}`)
    assert.ok(highlight.height >= line.height * 5, 'the continuous surface covers the full multiline paragraph')
  }
  await hoverLine.waitFor({ timeout: 20000 })
  await hoverLine.hover()
  await assertAligned()
  await page.getByRole('toolbar', { name: '悬停段落的操作' }).waitFor()
  assert.equal(await page.locator('.pr-hover-highlight').count(), 1, 'a single continuous surface highlights the paragraph without line gaps')
  await page.locator('.pr-scroll').evaluate(element => { element.scrollTop += 180 })
  await page.waitForTimeout(300)
  await hoverLine.hover()
  await assertAligned()
  await mkdir('test-results', { recursive: true })
  await page.screenshot({ path: 'test-results/hover.png' })
  await page.locator('.pr-selection-menu button').nth(2).click()
  await page.waitForFunction(() => window.testHarness.references.length === 1 && window.testHarness.sentMessages.length === 2 && document.querySelector('#draft').textContent.includes('根据这段选段回答：'))
  const hoverDraft = await page.locator('#draft').textContent()
  assert.match(hoverDraft, /@PDF选段 · 第2页/)
  assert.doesNotMatch(hoverDraft, /logged simulator transitions|On one GPU|Contributions\./, 'the composer stays compact and excludes full text and other paragraphs')
  const referenceText = await page.evaluate(async () => {
    const reference = window.testHarness.references[0]
    const source = window.testHarness.inputTriggers.sources.find(item => item.name === 'paper-reader-quote')
    return await source.codec.serialize(reference.ref)
  })
  assert.match(referenceText, /logged simulator transitions/)
  assert.match(referenceText, /第 2 页/)
  await page.getByRole('button', { name: '放大' }).click()
  assert.equal(await page.locator('.pr-page-input input').inputValue(), '2')
  assert.equal(await page.locator('.pr-zoom').textContent(), '125%')
  await hoverLine.hover()
  await assertAligned()
  await page.evaluate(() => window.testHarness.renderLocal())
  await page.locator('input[type=file]').waitFor()
  await page.evaluate(() => window.testHarness.renderDocument())
  await page.waitForFunction(() => document.querySelector('.pr-page-input input')?.value === '2' && document.querySelector('.pr-zoom')?.textContent === '125%')

  await page.locator('.pr-page-input input').fill('3')
  await page.locator('.pr-page-input input').press('Enter')
  const tableCaption = page.locator('[data-pdf-page="3"] .pr-text-layer span').filter({ hasText: 'Table 1:' }).first()
  await tableCaption.waitFor({ timeout: 20000 })
  const tableBox = await tableCaption.boundingBox()
  assert.ok(tableBox)
  await page.locator('[data-pdf-page="3"] .pr-text-layer span').filter({ hasText: 'MaskedMimic [9]' }).first().hover()
  await page.getByRole('toolbar', { name: '图表操作' }).waitFor({ timeout: 5000 })
  assert.equal(await page.locator('.pr-selection-menu button').count(), 2)
  await page.screenshot({ path: 'test-results/table-hover.png' })
  await page.locator('.pr-selection-menu button').first().click()
  await page.waitForFunction(() => window.testHarness.sentMessages.length === 3)
  assert.equal(await page.evaluate(() => window.testHarness.sentMessages.at(-1).text), '解释这张图表')
  assert.match(await page.evaluate(() => window.testHarness.sentMessages[2].files[0].name), /第3页/)

  await page.locator('.pr-page-input input').fill('4')
  await page.locator('.pr-page-input input').press('Enter')
  const figure2Caption = page.locator('[data-pdf-page="4"] .pr-text-layer span').filter({ hasText: 'Figure 2:' }).first()
  await figure2Caption.waitFor({ timeout: 20000 })
  const figure2Box = await figure2Caption.boundingBox()
  assert.ok(figure2Box)
  await page.mouse.move(figure2Box.x + figure2Box.width / 2, figure2Box.y - 65)
  await page.getByRole('toolbar', { name: '图表操作' }).waitFor({ timeout: 5000 })
  const figure2Highlight = await page.locator('.pr-figure-highlight').boundingBox()
  assert.ok(figure2Highlight)
  await page.locator('.pr-selection-menu button').first().click()
  await page.waitForFunction(() => window.testHarness.sentMessages.length === 4)
  const figure2Image = await page.evaluate(async () => {
    const file = window.testHarness.sentMessages[3].files[0]
    const dataUrl = await new Promise(resolve => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.readAsDataURL(file) })
    const dimensions = await new Promise(resolve => { const image = new Image(); image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight }); image.src = dataUrl })
    return { dataUrl, ...dimensions }
  })
  await writeFile('test-results/figure2.png', Buffer.from(figure2Image.dataUrl.split(',')[1], 'base64'))
  assert.ok(figure2Image.width >= figure2Highlight.width * 2, `full three-panel figure is rendered at high resolution: ${JSON.stringify({ figure2Image, figure2Highlight })}`)
  assert.ok(figure2Image.height >= figure2Highlight.height * 2, 'full figure height and detail are preserved')

  await page.locator('.pr-page-input input').fill('7')
  await page.locator('.pr-page-input input').press('Enter')
  const figure3Caption = page.locator('[data-pdf-page="7"] .pr-text-layer span').filter({ hasText: 'Figure 3:' }).first()
  await figure3Caption.waitFor({ timeout: 20000 })
  const figure3Box = await figure3Caption.boundingBox()
  assert.ok(figure3Box)
  const chartTitle = await page.locator('[data-pdf-page="7"] .pr-text-layer span').filter({ hasText: 'Normalized return' }).first().boundingBox()
  assert.ok(chartTitle)
  await page.mouse.move(chartTitle.x + 20, chartTitle.y - 25)
  await page.waitForTimeout(400)
  assert.equal(await page.getByRole('toolbar', { name: '图表操作' }).count(), 0, 'empty space above the chart does not activate it')
  await page.mouse.move(figure3Box.x + figure3Box.width / 2, figure3Box.y - 65)
  await page.getByRole('toolbar', { name: '图表操作' }).waitFor({ timeout: 5000 })
  const figure3Highlight = await page.locator('.pr-figure-highlight').boundingBox()
  assert.ok(figure3Highlight)
  assert.ok(Math.abs(figure3Highlight.y - chartTitle.y) < 12, `the highlight starts at the chart, excluding the page-top whitespace: ${JSON.stringify({ figure3Highlight, chartTitle })}`)
  assert.ok(figure3Highlight.y + figure3Highlight.height <= figure3Box.y + 2, 'the figure highlight excludes its caption')
  await page.screenshot({ path: 'test-results/figure3-hover.png' })
  await page.locator('.pr-selection-menu button').first().click()
  await page.waitForFunction(() => window.testHarness.sentMessages.length === 5)
  const figure3Image = await page.evaluate(async () => {
    const file = window.testHarness.sentMessages[4].files[0]
    const dataUrl = await new Promise(resolve => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.readAsDataURL(file) })
    const dimensions = await new Promise(resolve => { const image = new Image(); image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight }); image.src = dataUrl })
    return { dataUrl, ...dimensions }
  })
  await writeFile('test-results/figure3.png', Buffer.from(figure3Image.dataUrl.split(',')[1], 'base64'))
  assert.ok(figure3Image.width >= figure3Highlight.width * 2 && figure3Image.height >= figure3Highlight.height * 2, 'small chart text is rendered at high resolution')

  await page.evaluate(() => window.testHarness.renderLocal())
  await page.locator('input[type=file]').setInputFiles(pdf)
  await page.waitForFunction(() => document.querySelectorAll('[data-pdf-page]').length === 19)
  assert.ok((await page.locator('.pr-filename').textContent()).endsWith('.pdf'))
  const lateActivation = await page.evaluate(() => window.testHarness.lateActivation())
  assert.deepEqual(lateActivation, { inputAfterLateService: true, quietWithoutServices: true, previewAfterLateService: true, tabAfterLateService: true, buttonAfterLateService: true })
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ status: 'passed', pages: 19, quote: true, hoverParagraph: true, hoverAlignedAfterScrollAndZoom: true, figureAttachment: true, fullCompositeFigure: true, menuPersistence: true, inlineQuoteChip: true, tableAttachment: true, pageRestore: true, localFile: true, lateActivation, errors }))
} finally {
  await browser.close()
}
