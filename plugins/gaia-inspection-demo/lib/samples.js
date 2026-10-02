// gaia-inspection-demo / lib/samples.js
// 演示样例的**图**：用零第三方 PNG 画布合成三张示例图（确定性，同种子同结果）。
//
// 诚实标注（重要）：这是**几何图形合成的示例图**，不是真实门店照片；每张都会带
// `demoLabel`，看板与交付文档里一律标为合成样例。目的是让"达标态 / 问题态 / 看不清"
// 三种界面表现可复现，而不是冒充真实照片。
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { addNoise, blurBox, drawEllipse, encodePng, fillRect, newImage } from './png.js'

export const DEMO_IMAGE_LABEL = '合成示例图（几何图形合成，非真实门店照片）'

function tileFloor(width, height) {
  const img = newImage(width, height, 3, [214, 216, 214])
  // 浅色地砖网格
  for (let x = 0; x < width; x += 80) fillRect(img, x, 0, 2, height, [186, 188, 186])
  for (let y = 0; y < height; y += 80) fillRect(img, 0, y, width, 2, [186, 188, 186])
  return img
}

/** ① 达标态：干净地面 + 操作台（无问题物）。 */
function cleanScene(width = 640, height = 480) {
  const img = tileFloor(width, height)
  fillRect(img, 40, 40, width - 80, 120, [226, 228, 226]) // 操作台面
  fillRect(img, 40, 152, width - 80, 10, [150, 152, 150])
  for (let x = 300; x < 420; x += 30) drawEllipse(img, x, 100, 9, 9, [205, 208, 205]) // 空置容器轮廓
  return img
}

/** ② 问题态：地面上有深色散落杂物与一摊污渍。 */
function issueScene(width = 640, height = 480) {
  const img = cleanScene(width, height)
  drawEllipse(img, 170, 350, 34, 20, [70, 64, 58])
  drawEllipse(img, 214, 372, 22, 14, [84, 78, 70])
  drawEllipse(img, 132, 388, 16, 11, [96, 90, 82])
  drawEllipse(img, 430, 330, 52, 26, [108, 96, 78]) // 地面污渍
  return addNoise(img, 6, 20261001)
}

/** ③ 看不清态：拍偏 + 失焦 + 过暗（演示 unreadable 分支）。 */
function unreadableScene(width = 640, height = 480) {
  const img = issueScene(width, height)
  blurBox(img, 7)
  addNoise(img, 30, 424242)
  const { data } = img
  for (let i = 0; i < data.length; i += 1) data[i] = Math.round(data[i] * 0.42) // 过暗
  return img
}

export function buildSamples() {
  const scene = { clean: cleanScene(), issue: issueScene(), unreadable: unreadableScene() }
  const out = []
  for (const [key, img] of Object.entries(scene)) {
    const bytes = encodePng(img)
    out.push({
      key,
      name: `sample-${key}.png`,
      mediaType: 'image/png',
      bytes,
      width: img.width,
      height: img.height,
      photoId: createHash('sha256').update(bytes).digest('hex').slice(0, 16),
      label: DEMO_IMAGE_LABEL,
    })
  }
  return out
}

/** 把合成样例图写进本单数据根的 photos 目录（内容寻址，幂等）。 */
export function writeSamples(photoDir) {
  mkdirSync(photoDir, { recursive: true })
  const samples = buildSamples()
  for (const s of samples) {
    const p = join(photoDir, `${s.photoId}.png`)
    if (!existsSync(p)) writeFileSync(p, s.bytes)
    s.originalPath = p
  }
  return samples
}
