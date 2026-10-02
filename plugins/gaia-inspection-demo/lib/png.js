// gaia-inspection-capture / lib/png.js
// 零第三方图片处理：PNG 编解码 + 最近邻/箱式缩放 + 演示图合成用画布操作。
// 只用 node: 内置模块（node:zlib）。
//
// 为什么自己写：本单要求「零第三方依赖优先」。宿主已带 sharp（dsh-attachment-local 用），
// 缩略图**首选宿主图像管线**（ctx.attachments.readImageRequest），本文件是它的**兜底**：
//   · 能解就解（PNG 8bit 灰度/RGB/RGBA，非隔行）；
//   · 解不了（JPEG/WebP/GIF/隔行 PNG/16bit/调色板）→ 明确返回 `THUMB_UNSUPPORTED`，
//     **绝不假装生成了缩略图**。
// 另外本文件提供确定性的画布操作，供 gaia-inspection-demo 合成"演示样例照片"
// （合成图会在产物里明确标注为合成示例图，不冒充真实门店照片）。
import { deflateSync, inflateSync } from 'node:zlib'

const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

export function isPng(bytes) {
  if (!bytes || bytes.length < 8) return false
  for (let i = 0; i < 8; i += 1) if (bytes[i] !== SIG[i]) return false
  return true
}

// ── CRC32（PNG 块校验） ───────────────────────────────────────────────────────
let CRC_TABLE = null
function crcTable() {
  if (CRC_TABLE) return CRC_TABLE
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  CRC_TABLE = t
  return t
}
function crc32(buf) {
  const t = crcTable()
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i += 1) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), Buffer.from(data)])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}

/** 编码 8bit PNG（channels 3 = RGB，4 = RGBA）。 */
export function encodePng(image) {
  const { width, height, channels, data } = image
  const raw = Buffer.alloc(height * (1 + width * channels))
  let p = 0
  for (let y = 0; y < height; y += 1) {
    raw[p] = 0 // filter 0
    p += 1
    for (let x = 0; x < width * channels; x += 1) raw[p + x] = data[y * width * channels + x]
    p += width * channels
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = channels === 4 ? 6 : channels === 3 ? 2 : 0
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  return Buffer.concat([
    Buffer.from(SIG),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  return pb <= pc ? b : c
}

/**
 * 解码 PNG 到 {width,height,channels,data}（channels 1/3/4 归一为 3 或 4）。
 * 不支持：调色板（3）、16bit、隔行、非 PNG —— 一律返回 {ok:false}（不猜）。
 */
export function decodePng(bytes) {
  if (!isPng(bytes)) return { ok: false, error: { code: 'NOT_PNG', message: '不是 PNG（魔数不符）' } }
  let off = 8
  let ihdr = null
  const idat = []
  while (off + 8 <= bytes.length) {
    const len = bytes.readUInt32BE(off)
    const type = bytes.toString('latin1', off + 4, off + 8)
    const start = off + 8
    const end = start + len
    if (end > bytes.length) break
    if (type === 'IHDR') {
      ihdr = {
        width: bytes.readUInt32BE(start),
        height: bytes.readUInt32BE(start + 4),
        bitDepth: bytes[start + 8],
        colorType: bytes[start + 9],
        interlace: bytes[start + 12],
      }
    } else if (type === 'IDAT') idat.push(bytes.subarray(start, end))
    else if (type === 'IEND') break
    off = end + 4
  }
  if (!ihdr) return { ok: false, error: { code: 'PNG_NO_IHDR', message: 'PNG 缺少 IHDR' } }
  if (ihdr.bitDepth !== 8) return { ok: false, error: { code: 'PNG_BITDEPTH', message: `仅支持 8bit PNG（实际 ${ihdr.bitDepth}bit）` } }
  if (ihdr.interlace !== 0) return { ok: false, error: { code: 'PNG_INTERLACED', message: '不支持隔行 PNG' } }
  const chMap = { 0: 1, 2: 3, 4: 2, 6: 4 }
  const srcCh = chMap[ihdr.colorType]
  if (!srcCh) return { ok: false, error: { code: 'PNG_COLORTYPE', message: `不支持的 PNG 颜色类型：${ihdr.colorType}` } }
  let raw
  try {
    raw = inflateSync(Buffer.concat(idat))
  } catch (error) {
    return { ok: false, error: { code: 'PNG_INFLATE_FAILED', message: `PNG 数据解压失败：${String((error && error.message) || error)}` } }
  }
  const { width, height } = ihdr
  const stride = width * srcCh
  if (raw.length < height * (stride + 1)) return { ok: false, error: { code: 'PNG_TRUNCATED', message: 'PNG 像素数据不完整' } }
  const out = new Uint8Array(width * height * srcCh)
  let prev = new Uint8Array(stride)
  let rp = 0
  for (let y = 0; y < height; y += 1) {
    const filter = raw[rp]
    rp += 1
    const line = new Uint8Array(stride)
    for (let i = 0; i < stride; i += 1) {
      const x = raw[rp + i]
      const a = i >= srcCh ? line[i - srcCh] : 0
      const b = prev[i]
      const c = i >= srcCh ? prev[i - srcCh] : 0
      let v
      switch (filter) {
        case 0: v = x; break
        case 1: v = x + a; break
        case 2: v = x + b; break
        case 3: v = x + ((a + b) >> 1); break
        case 4: v = x + paeth(a, b, c); break
        default: return { ok: false, error: { code: 'PNG_FILTER', message: `未知 PNG 行过滤类型：${filter}` } }
      }
      line[i] = v & 0xff
    }
    rp += stride
    out.set(line, y * stride)
    prev = line
  }
  if (srcCh === 4) return { ok: true, image: { width, height, channels: 4, data: out } }
  if (srcCh === 3) return { ok: true, image: { width, height, channels: 3, data: out } }
  // 灰度 / 灰度+透明 -> 归一为 RGB
  const rgb = new Uint8Array(width * height * 3)
  for (let i = 0; i < width * height; i += 1) {
    const g = out[i * srcCh]
    rgb[i * 3] = g
    rgb[i * 3 + 1] = g
    rgb[i * 3 + 2] = g
  }
  return { ok: true, image: { width, height, channels: 3, data: rgb } }
}

// ── 画布操作（演示图合成 + 兜底缩放共用） ──────────────────────────────────────
export function newImage(width, height, channels = 3, fill = [255, 255, 255]) {
  const data = new Uint8Array(width * height * channels)
  for (let i = 0; i < width * height; i += 1) {
    for (let c = 0; c < channels; c += 1) data[i * channels + c] = fill[c] ?? 255
  }
  return { width, height, channels, data }
}

export function fillRect(img, x0, y0, w, h, rgb) {
  const { width, height, channels, data } = img
  for (let y = Math.max(0, y0); y < Math.min(height, y0 + h); y += 1) {
    for (let x = Math.max(0, x0); x < Math.min(width, x0 + w); x += 1) {
      const i = (y * width + x) * channels
      for (let c = 0; c < 3 && c < channels; c += 1) data[i + c] = rgb[c] ?? 0
    }
  }
  return img
}

export function drawEllipse(img, cx, cy, rx, ry, rgb) {
  const { width, height, channels, data } = img
  for (let y = Math.max(0, cy - ry); y < Math.min(height, cy + ry); y += 1) {
    for (let x = Math.max(0, cx - rx); x < Math.min(width, cx + rx); x += 1) {
      const dx = (x - cx) / rx
      const dy = (y - cy) / ry
      if (dx * dx + dy * dy <= 1) {
        const i = (y * width + x) * channels
        for (let c = 0; c < 3 && c < channels; c += 1) data[i + c] = rgb[c] ?? 0
      }
    }
  }
  return img
}

/** 确定性伪随机（mulberry32）——同样的种子给同样的图，便于复现。 */
export function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function addNoise(img, amplitude, seed) {
  const r = rng(seed)
  const { data, channels } = img
  for (let i = 0; i < data.length; i += channels) {
    const d = Math.round((r() - 0.5) * 2 * amplitude)
    for (let c = 0; c < 3 && c < channels; c += 1) data[i + c] = Math.max(0, Math.min(255, data[i + c] + d))
  }
  return img
}

/** 箱式模糊（半径 r），用于合成「拍偏/失焦」的演示样例。 */
export function blurBox(img, radius) {
  const { width, height, channels, data } = img
  const tmp = new Uint8Array(data.length)
  const r = Math.max(1, Math.round(radius))
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const acc = [0, 0, 0]
      let n = 0
      for (let dy = -r; dy <= r; dy += 1) {
        const yy = Math.min(height - 1, Math.max(0, y + dy))
        for (let dx = -r; dx <= r; dx += 1) {
          const xx = Math.min(width - 1, Math.max(0, x + dx))
          const i = (yy * width + xx) * channels
          for (let c = 0; c < 3 && c < channels; c += 1) acc[c] += data[i + c]
          n += 1
        }
      }
      const o = (y * width + x) * channels
      for (let c = 0; c < 3 && c < channels; c += 1) tmp[o + c] = Math.round(acc[c] / n)
      if (channels === 4) tmp[o + 3] = data[o + 3]
    }
  }
  img.data = tmp
  return img
}

export function longEdgeTarget(width, height, longEdge) {
  const le = Math.max(1, Math.round(longEdge))
  if (le >= Math.max(width, height)) return { width, height }
  return width >= height
    ? { width: le, height: Math.max(1, Math.round((le * height) / width)) }
    : { width: Math.max(1, Math.round((le * width) / height)), height: le }
}

/** 面积平均（箱式）缩放；零第三方、确定性。 */
export function resizeBox(img, target) {
  const { width, height, channels, data } = img
  const { width: tw, height: th } = target
  const out = new Uint8Array(tw * th * channels)
  const xRatio = width / tw
  const yRatio = height / th
  for (let ty = 0; ty < th; ty += 1) {
    const y0 = Math.floor(ty * yRatio)
    const y1 = Math.max(y0 + 1, Math.min(height, Math.ceil((ty + 1) * yRatio)))
    for (let tx = 0; tx < tw; tx += 1) {
      const x0 = Math.floor(tx * xRatio)
      const x1 = Math.max(x0 + 1, Math.min(width, Math.ceil((tx + 1) * xRatio)))
      const acc = [0, 0, 0, 0]
      let n = 0
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          const i = (y * width + x) * channels
          for (let c = 0; c < channels; c += 1) acc[c] += data[i + c]
          n += 1
        }
      }
      const o = (ty * tw + tx) * channels
      for (let c = 0; c < channels; c += 1) out[o + c] = Math.round(acc[c] / Math.max(1, n))
    }
  }
  return { width: tw, height: th, channels, data: out }
}

/** 读图片头的宽高（只读头部，不整图解码）：PNG 走 IHDR。 */
export function pngSize(bytes) {
  if (!isPng(bytes)) return null
  try {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
  } catch {
    return null
  }
}
