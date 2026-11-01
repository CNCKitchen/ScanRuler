// SPDX-License-Identifier: AGPL-3.0-only
// Public UI only: verify the bundled sample chunk and measurement path.
import assert from 'node:assert/strict'
import puppeteer from 'puppeteer-core'
import { mkdirSync } from 'node:fs'
import { CHROME, APP_URL, OUT_DIR } from './e2e-lib.mjs'
const out=OUT_DIR
mkdirSync(out,{recursive:true})
const browser=await puppeteer.launch({executablePath:CHROME,headless:true})
try {
 for (const [name,width,height] of [['desktop',1440,900],['phone',390,844]]) {
  const context=await browser.createBrowserContext(),page=await context.newPage(),errors=[]
  page.on('pageerror',e=>errors.push(e.message))
  await page.setViewport({width,height})
  await page.goto(APP_URL,{waitUntil:'networkidle0'})
  await page.waitForSelector('[data-test=open-measure-sample]')
  await page.screenshot({path:`${out}/${name}-start.png`})
  await page.click('[data-test=open-measure-sample]')
  await page.waitForFunction(()=>/3,072 triangles/.test(document.querySelector('.file-info')?.textContent??''))
  await page.click('[data-test=fit-plane]')
  if (name==='desktop') {
   const r=await page.$eval('.viewport canvas',el=>{const r=el.getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height}})
   await page.mouse.click(r.x+r.w*.5,r.y+r.h*.42)
   await page.waitForFunction(()=>document.querySelector('[data-test=create-element]')?.disabled===false)
   await page.screenshot({path:`${out}/desktop-preview.png`})
   await page.click('[data-test=create-element]')
   await page.keyboard.press('Escape')
   await page.waitForSelector('[role=treeitem]')
   assert.equal(await page.$$eval('[role=treeitem]',els=>els.length),1)
  }
  await page.screenshot({path:`${out}/${name}-sample.png`})
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true)
  assert.deepEqual(errors,[])
  console.log(`PASS: production ${name}: sample chunk loads, real mesh renders, visible controls and no browser errors`)
  await context.close()
 }
} finally {await browser.close()}
