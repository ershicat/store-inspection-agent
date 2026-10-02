// 门店督导 / lib/gaia-tools.js（各包各带一份副本，避免跨包 import）
// 共用工具工厂解析：优先用宿主 ctx.tools.defineTool；拿不到时退到宿主运行时里的
// @deepseek-ai/dsh-tools；再拿不到就用内置等价实现（只支持本单用到的 schema 词汇）。
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export async function resolveDefineTool(ctx) {
  const t = ctx && ctx.tools
  if (t && typeof t.defineTool === 'function') return t.defineTool
  try {
    const mod = await import('@deepseek-ai/dsh-tools')
    if (mod && typeof mod.defineTool === 'function') return mod.defineTool
  } catch {
    process.stderr.write('[gaia-inspection] 直接导入 @deepseek-ai/dsh-tools 失败：尝试宿主候选路径\n')
  }
  for (const candidate of hostCandidates()) {
    try {
      const mod = await import(pathToFileURL(candidate).href)
      if (mod && typeof mod.defineTool === 'function') return mod.defineTool
    } catch {
      /* 逐个候选尝试 */
    }
  }
  process.stderr.write('[gaia-inspection] 未解析到宿主 defineTool：改用内置等价实现\n')
  return fallbackDefineTool
}

function hostCandidates() {
  const out = []
  const home = String(process.env.DSH_HOME || '').trim()
  if (home) out.push(join(home, '..', '..', 'resources', 'runtime', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'))
  out.push(join(process.cwd(), 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'))
  return out.filter((p) => {
    try {
      return existsSync(p)
    } catch {
      return false
    }
  })
}

// schema 方言只用：type / items / properties / additionalProperties / enum / const / description / required
export function schemaOf(spec) {
  const out = { type: 'object', properties: {}, required: [] }
  for (const [key, p] of Object.entries(spec || {})) {
    out.properties[key] = schemaNode(p)
    if (p && p.required === true) out.required.push(key)
  }
  if (out.required.length === 0) delete out.required
  return out
}

function schemaNode(p) {
  const node = {}
  if (!p || typeof p !== 'object') return node
  if (p.type) node.type = p.type
  if (p.items) node.items = Array.isArray(p.items) ? p.items.map(schemaNode) : schemaNode(p.items)
  if (p.properties) node.properties = Object.fromEntries(Object.entries(p.properties).map(([k, v]) => [k, schemaNode(v)]))
  if (p.additionalProperties !== undefined) node.additionalProperties = p.additionalProperties
  if (p.enum) node.enum = p.enum
  if (p.const !== undefined) node.const = p.const
  if (p.description) node.description = p.description
  return node
}

export function fallbackDefineTool(options) {
  const parameters = schemaOf(options.parameters)
  const validate = (args) => {
    const violations = []
    for (const key of parameters.required || []) {
      const v = args ? args[key] : undefined
      if (v === undefined || v === null || v === '') violations.push(`/${key}: required`)
    }
    return violations
  }
  const tool = {
    name: options.name,
    description: options.description,
    parameters,
    output: { schema: options.output.schema, render: (args, value) => options.output.render(args, value) },
    async execute(args, exec) {
      const violations = validate(args)
      if (violations.length > 0) {
        const err = new Error(`tool "${options.name}" 参数不合规：${violations.join('; ')}`)
        err.code = 'TOOL_ARGS_INVALID'
        throw err
      }
      return options.execute(args, exec)
    },
  }
  if (options.presentResult) tool.presentResult = (args, result) => (validate(args).length ? undefined : options.presentResult(args, result))
  return tool
}
