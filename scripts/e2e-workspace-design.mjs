// SPDX-License-Identifier: AGPL-3.0-only
// Cross-workspace shell and scanner guidance through real controls.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchApp, finish, check, canvasRect, OUT_DIR, clickTool, sleep, downloadsTo, awaitDownload, fieldSetter } from './e2e-lib.mjs'
const out=join(OUT_DIR,'workspace-design');mkdirSync(out,{recursive:true})
const {browser,page,consoleErrors}=await launchApp({width:1440,height:900})
const downloads=mkdtempSync(join(out,'downloads-'));await downloadsTo(page,downloads)
const records=[]
const click=async s=>{await page.waitForSelector(s,{visible:true});await page.click(s);await sleep(100)}
const guide=()=>page.$eval('[data-test=measurement-guide]',e=>e.textContent)
const metrics=()=>page.evaluate(()=>({workspace:document.querySelector('.app').dataset.workspace,theme:document.documentElement.dataset.theme,design:document.documentElement.dataset.design,top:document.querySelector('.top').getBoundingClientRect().height,rail:document.querySelector('.modeswitch').getBoundingClientRect().width,stage:getComputedStyle(document.documentElement).getPropertyValue('--stage').trim(),overflow:document.documentElement.scrollWidth>innerWidth}))
try{
 await click('[data-test=open-measure-guide]');check((await guide()).includes('Step 1 of 7'),'guide starts with the real import step')
 await click('[data-test=open-measure-sample]');await page.waitForFunction(()=>/3,072 triangles/.test(document.querySelector('.file-info')?.textContent??''))
 check((await guide()).includes('Step 2 of 7'),'guide detects imported scan and asks for a scale check')
 await click('[data-test=guide-scale-checked]');await click('[data-test=guide-task-0]')
 for(const y of [.42,.17]){
  await click('[data-test=guide-start-fit]');const r=await canvasRect(page);await page.mouse.click(r.x+r.w*.5,r.y+r.h*y)
  await page.waitForFunction(()=>document.querySelector('[data-test=create-element]')?.disabled===false)
  check((await guide()).includes('not a guarantee'),'guide explains that fit scatter is not scanner accuracy')
  await click('[data-test=create-element]');await page.keyboard.press('Escape')
 }
 check((await guide()).includes('Step 5 of 7'),'two real fits advance to the dimension step')
 await click('[data-test=guide-start-dimension]')
 const ids=await page.$$eval('[data-test=dim-ref-0] option',es=>es.map(e=>e.value).filter(Boolean))
 await page.select('[data-test=dim-ref-0]',ids[0]);await page.select('[data-test=dim-ref-1]',ids[1]);await click('[data-test=add-dimension]');await page.keyboard.press('Escape')
 check((await guide()).includes('Step 6 of 7'),'committed measurement advances to recovery practice')
 await click('[data-test=undo]');check((await guide()).includes('Now use Redo'),'guide follows real undo')
 await click('[data-test=redo]');await sleep(100);check((await guide()).includes('Step 7 of 7'),'guide follows real redo and explains saving')
 await click('[data-test=save-project]');await page.waitForFunction(()=>document.querySelector('[data-test=measurement-guide]')?.textContent.includes('Project download started'))
 const downloaded=await awaitDownload(downloads,'.scanruler')
 check(Boolean(downloaded),'guide saves an actual editable project download')
 if(await page.$('dialog[open]'))await page.keyboard.press('Escape')
 page.once('dialog', dialog => dialog.accept())
 await (await page.$('[data-test=project-input]')).uploadFile(join(downloads,downloaded))
 await page.waitForFunction(()=>document.querySelector('.strip')?.textContent.includes('Project opened'))
 check((await guide()).includes('Step 2 of 7'),'reopening a source with the same filename requires a fresh scale check')
 await click('[data-test=guide-scale-checked]');await click('[data-test=guide-task-0]')
 check((await guide()).includes('no undo history yet'),'guide explains recovery practice for a reopened project without history')

 const saved=await page.$eval('.project-measurements',e=>e.textContent)
 for(const id of ['deviation','thickness','flat','reverse','mesh','elements']){
  await click(`[data-test=workspace-${id}]`);const m=await metrics();records.push(m)
  check(m.design==='measure'&&m.top===48&&m.rail===56&&!m.overflow,`${id}: shared desktop shell remains in place`)
 }
 check((await page.$eval('.project-measurements',e=>e.textContent))===saved,'workspace round trip preserves the measured result')
 await click('[data-test=workspace-thickness]')
 await fieldSetter(page)('[data-test=thickness-max]', '40')
 await click('[data-test=measure-thickness]')
 await page.waitForSelector('[data-test=thickness-low]',{visible:true})
 const thickness=await page.$$eval('[data-test=thickness-low], [data-test=thickness-high]',es=>es.map(e=>Number(e.value)))
 check(thickness.length===2&&thickness.every(v=>Number.isFinite(v)&&v>0&&v<=40),'thickness controls produce a finite wall map from the sample')
 await click('[data-test=workspace-deviation]');await click('[data-test=source-element]')
 const target=await page.$eval('[data-test=target-select]',e=>Array.from(e.options).find(o=>o.value)?.value)
 await page.select('[data-test=target-select]',target)
 await page.waitForSelector('[data-test=range-slider]',{visible:true})
 check(await page.$eval('[data-test=target-select]',e=>Boolean(e.value)),'deviation controls map the scan against its real fitted plane')
 await click('[data-test=open-settings]');await click('[data-test=ui-theme-dark]');await click('[data-test=settings-close]')
 for(const id of ['elements','deviation','thickness','flat','reverse','mesh']){
  await click(`[data-test=workspace-${id}]`);const m=await metrics();records.push(m)
  check(m.stage==='#080c12'&&m.theme==='dark',`${id}: darker canvas theme persists`)
  await page.screenshot({path:join(out,`dark-${id}.png`)})
 }
 await clickTool(page,'[data-test=mesh-tool-smooth]')
 check(await page.$eval('.dock-actions [data-test=smooth-scan]',e=>!e.disabled),'mesh action is in the persistent footer')
 const setting=await page.$eval('[data-test=smooth-tool] input[type=number]',e=>e.value)
 await click('[aria-label="Hide Mesh tools"]');await click('[data-test=workspace-tools]')
 check(await page.$eval('[data-test=smooth-tool] input[type=number]',e=>e.value)===setting,'hiding the context panel preserves mesh tool settings')
 await click('[data-test=measure-search]');await page.type('.command-search-dialog input','Keep sharp edges');await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');await sleep(100)
 check(await page.evaluate(()=>document.activeElement?.getAttribute('data-test')==='smooth-edges'),'search opens and focuses the existing tool control')
 for(const [width,height]of [[900,800],[390,844],[320,568],[720,450]]){
  await page.setViewport({width,height});await sleep(100)
  for(const id of ['deviation','thickness','flat','reverse','mesh']){
   await click(`[data-test=workspace-${id}]`);const m=await metrics();records.push({width,height,...m});check(!m.overflow&&m.top===48,`${id}: no page overflow at ${width}×${height}`)
   await page.screenshot({path:join(out,`${width}-${id}.png`)})
  }
 }
 assert.equal(consoleErrors.length,0)
 writeFileSync(join(out,'metrics.json'),JSON.stringify(records,null,2))
}finally{await finish(browser,consoleErrors)}
