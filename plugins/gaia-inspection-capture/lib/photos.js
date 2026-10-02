// gaia-inspection-capture / lib/photos.js
// 照片落盘与缩略图（能力词：照片缩略与附件预览）。
//
// 口径：
//   · 原图**原样保留**，按内容寻址命名 `<sha256 前 16 位>.<ext>`，落在 `<数据根>/photos/`；
//   · 缩略图落 `<数据根>/thumbs/<photoId>.<ext>`，长边 ≤ 512（可用参数覆盖）；
//   · 缩略图**首选宿主图像管线**（`ctx.attachments.readImageRequest`，由宿主的 sharp 实现，
//     本包不引入任何第三方依赖）；宿主管线不可用时，退到本包自带的零第三方 PNG 缩放；
//     连解码都做不到（JPEG/WebP/GIF/隔行 PNG）→ 明确回 `THUMB_UNSUPPORTED`，**不假装生成**。
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { decodePng, encodePng, isPng, longEdgeTarget, pngSize, resizeBox } from './png.js'

export const DEFAULT_THUMB_LONG_EDGE = 512
export const DEFAULT_THUMB_MAX_BYTES = 262144

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

export function photoIdOf(bytes) {
  return sha256Hex(bytes).slice(0, 16)
}

/** 从魔数判图片类型（不信任扩展名）；判不出就是 null（不猜）。 */
export function mediaTypeOf(bytes) {
  if (!bytes || bytes.length < 12) return null
  if (isPng(bytes)) return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return 'image/webp'
  if (bytes.toString('latin1', 0, 4) === 'GIF8') return 'image/gif'
  return null
}

export function extForMediaType(mediaType) {
  switch (mediaType) {
    case 'image/png': return '.png'
    case 'image/jpeg': return '.jpg'
    case 'image/webp': return '.webp'
    case 'image/gif': return '.gif'
    default: return '.bin'
  }
}

export function findById(dir, photoId) {
  if (!existsSync(dir)) return null
  const hit = readdirSync(dir).find((n) => n.toLowerCase().startsWith(`${String(photoId).toLowerCase()}.`))
  return hit ? join(dir, hit) : null
}

/** 保存原图（内容寻址，重复照片天然去重）。 */
export function saveOriginal({ bytes, mediaType, photoDir }) {
  mkdirSync(photoDir, { recursive: true })
  const photoId = photoIdOf(bytes)
  const ext = extForMediaType(mediaType)
  const path = join(photoDir, `${photoId}${ext}`)
  if (!existsSync(path)) writeFileSync(path, bytes)
  return { photoId, path, ext, bytes: bytes.length }
}

/** 读原图尺寸：PNG 读头部；其它格式交给宿主管线时顺带得到（此处不猜）。 */
export function sizeOf(bytes) {
  const s = pngSize(bytes)
  return s ? { width: s.width, height: s.height, via: 'png-header' } : { width: null, height: null, via: 'unknown' }
}

/**
 * 生成缩略图。
 * @returns {{ok:true, photoId, thumbPath, width, height, longEdge, via}|{ok:false,code,message}}
 */
export async function makeThumb(ctx, { bytes, mediaType, photoDir, thumbDir, longEdge = DEFAULT_THUMB_LONG_EDGE, maxBytes = DEFAULT_THUMB_MAX_BYTES }) {
  mkdirSync(thumbDir, { recursive: true })
  const photoId = photoIdOf(bytes)
  const le = Math.max(32, Math.round(longEdge))
  // 命名约定：**默认长边**用 `<photoId>.<ext>`（看板小图与读图路由按这个名取）；
  //           非默认长边用 `<photoId>-le<长边>.<ext>`（内部产物，只由工具返回 thumbPath）。
  const base = le === DEFAULT_THUMB_LONG_EDGE ? photoId : `${photoId}-le${le}`
  const existing = findById(thumbDir, base)
  if (existing) {
    const s = sizeOf(readFileSync(existing))
    return { ok: true, photoId, thumbPath: existing, width: s.width, height: s.height, longEdge: le, via: 'cache' }
  }

  // 首选：宿主图像管线（attachments.readImageRequest）——宿主自带 sharp，本包零第三方。
  const attachments = ctx && typeof ctx.get === 'function' ? ctx.get('attachments') : undefined
  if (attachments && typeof attachments.saveImages === 'function' && typeof attachments.readImageRequest === 'function') {
    try {
      const [ref] = await attachments.saveImages([{ data: bytes, mediaType }])
      const version = await attachments.readImageRequest(ref, { width: le, height: le, maxBytes })
      if (version && version.data && version.data.length > 0) {
        const ext = extForMediaType(version.mediaType || mediaType)
        const thumbPath = join(thumbDir, `${base}${ext}`)
        writeFileSync(thumbPath, version.data)
        return { ok: true, photoId, thumbPath, width: version.width ?? null, height: version.height ?? null, longEdge: le, via: 'host-attachments' }
      }
      return { ok: false, code: 'THUMB_EMPTY', message: '宿主图像管线返回了空缩略图字节，本次不写缩略图文件。' }
    } catch (error) {
      // 宿主管线失败 → 落到零第三方 PNG 兜底（不静默：最终结果里 via 会标出来源）
      const fallback = pngFallback(bytes, base, thumbDir, le)
      if (fallback.ok) return { ...fallback, via: 'png-fallback', hostError: String((error && error.message) || error) }
      return { ok: false, code: 'THUMB_UNSUPPORTED', message: `宿主图像管线不可用（${String((error && error.message) || error)}），且本包零第三方兜底只支持 PNG：${fallback.message}` }
    }
  }

  const fallback = pngFallback(bytes, base, thumbDir, le)
  if (fallback.ok) return { ...fallback, via: 'png-fallback' }
  return { ok: false, code: 'THUMB_UNSUPPORTED', message: `宿主未提供 attachments 服务，且本包零第三方兜底只支持 PNG：${fallback.message}` }
}

function pngFallback(bytes, base, thumbDir, longEdge) {
  const decoded = decodePng(bytes)
  if (!decoded.ok) return { ok: false, message: decoded.error.message }
  const img = decoded.image
  const target = longEdgeTarget(img.width, img.height, longEdge)
  const thumbPath = join(thumbDir, `${base}.png`)
  if (target.width === img.width && target.height === img.height) {
    writeFileSync(thumbPath, bytes)
    return { ok: true, photoId: base, thumbPath, width: img.width, height: img.height, longEdge, resized: false }
  }
  const small = resizeBox(img, target)
  writeFileSync(thumbPath, encodePng(small))
  return { ok: true, photoId: base, thumbPath, width: small.width, height: small.height, longEdge, resized: true }
}
