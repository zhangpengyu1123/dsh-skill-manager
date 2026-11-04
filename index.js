/**
 * @local/dsh-skill-manager —— 宿主半边（host half）
 *
 * 职责（契约 v3：技能按工作区管理 + AI 标签，见 dsh-skill-manager-spec.md）：
 *  1. 技能门禁：为每个 live Agent 在其 `agent.ctx` 作用域内注册一个 `skill-manager`
 *     provider，对「已禁用」以及「绑定了工作区但当前 cwd 不属于这些工作区」的技能返回
 *     rank = -1e9 的影子候选（层内胜出），让模型侧技能目录与 `skill` 工具都看不到它。
 *     注意：本 profile 的 `skill-filesystem` 只在 agent preset 作用域内挂载（host 层
 *     没有），所以全局 provider 会被 preset 层的同名条目压过；门禁必须按作用域注册。
 *  2. 维护技能清单（state.known 缓存）：对「workspaceRegistry 的每个工作区路径 +
 *     部署默认目录」×「global / agent preset / live Agent 作用域」做并集扫描；
 *     每条记录带 installedAt（birthtime，缺失回退 ctime）与 updatedAt（mtime）。
 *  3. 用 `sessionQuery` / `sessionPersistence` 增量统计每个技能的历史调用次数。
 *  4. 提供 `/skill-manager/api` 单一 HTTP 路由，供前端管理页读写（payload v3：
 *     workspaces / boundWorkspaces / tags / tagging / inventory 状态）。
 *  5. 删除技能时移动到 `<DSH_HOME>/skill-trash`（bundled / node_modules 内置技能拒绝删除）。
 *  6. AI 标签（契约 v3 §3）：空闲时用默认模型批量生成中文标签；已标注过的技能不重标；
 *     `tagNow` 可强制立刻跑一轮；模型缺失时降级为 tagging.enabled=false。
 *  7. 更新检测 / 更新执行（契约 v4 §1–2）：清单刷新时按 script / git / git-project /
 *     metadata / bundled 检测更新方式并缓存进 known；`POST {action:"skillUpdate"}`
 *     用固定参数的 spawnSync 执行检查（可选 apply），结果写 state.updates。
 *  8. 只读调试入口 `GET /skill-manager/api?debug=resolve[&session=<id>][&cwd=<path>]`：
 *     返回 cwd→workspace 解析结果，以及无作用域 / 给定会话作用域下 `ctx.skills.list()`
 *     的注册表解析结果（用于验收门禁）。
 *
 * 约束：纯 ESM，只 import Node 内置模块；不 import 任何 `@deepseek-ai/*` 包，
 * 可选服务一律通过 `ctx.get(name)` 惰性获取（缺失即降级）。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

export const name = 'skill-manager'
export const inject = ['skills', 'webServer']

/* ------------------------------------------------------------------ *
 * 常量
 * ------------------------------------------------------------------ */

/** 本插件在技能注册表里的 provider 名。 */
const PROVIDER_NAME = 'skill-manager'
/** 前端使用的唯一路由路径。 */
const ROUTE_PATH = '/skill-manager/api'
/** state.json 的结构版本（v3 = 工作区绑定 + AI 标签）。 */
const STATE_VERSION = 3
/** 影子候选的 rank：低于 filesystem 等真实 provider，保证在层内胜出。 */
const SHADOW_RANK = -1e9
/** 请求 / 状态文件里的技能名白名单（契约 §2）。 */
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
/** 注册表要求的严格 kebab-case（影子候选必须能通过 validateCandidate）。 */
const REGISTRY_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
/** 可用于会话统计/持久化层签名的会话 id 形状。 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/
/** 工作区 id 形状（registry 生成 uuid，这里放宽到安全字符集）。 */
const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/
/** 允许删除的技能来源（契约 §2 / §4.5）。 */
const DELETABLE_SOURCES = new Set(['user-dsh', 'user-agents', 'custom', 'project-dsh', 'project-agents'])
/** POST body 上限。 */
const MAX_BODY_BYTES = 64 * 1024
/** 单个技能的工作区绑定上限。 */
const MAX_BINDINGS = 50
/** 一次统计扫描最多读取的会话数。 */
const MAX_SCAN_SESSIONS = 400
/** 工作区选择器最多返回的工作区数。 */
const MAX_PICKER_WORKSPACES = 150
/** 统计扫描读取会话的并发度。 */
const SCAN_CONCURRENCY = 3
/** 工作区路径/标题缓存时长（workspaceRegistry.list() 投影的本地匹配缓存）。 */
const WORKSPACE_CACHE_MS = 10_000
/** 技能清单缓存时长：过期后后台重扫一次。 */
const INVENTORY_TTL_MS = 60_000
/** 一次清单扫描最多读取的 agent preset 作用域数。 */
const MAX_INVENTORY_PRESETS = 6
/** 一次清单扫描最多读取的 live Agent 作用域数。 */
const MAX_INVENTORY_AGENTS = 8
/** 清单扫描覆盖的工作区 cwd 上限（registry 顺序）。 */
const MAX_INVENTORY_WORKSPACE_CWDS = 12
/** 一次清单扫描的 snapshot 总数上限。 */
const MAX_INVENTORY_SNAPSHOTS = 100
/** agent/created、skills/change 触发的清单刷新防抖时长。 */
const INVENTORY_DEBOUNCE_MS = 1_500
/** 影子候选缺省描述。 */
const FALLBACK_DESCRIPTION = 'Disabled by Skill Manager'

/* ---- 标签（契约 v3） ---- */
/** 每个技能每类标签（user / ai / muted）最多保留的数量。 */
const MAX_TAGS_PER_LIST = 8
/** 单个标签最大字符数（trim 后）。 */
const MAX_TAG_LENGTH = 24
/** 每个 AI 标签响应里每个技能最多采用的标签数。 */
const MAX_AI_TAGS_PER_SKILL = 2
/** 送给模型的描述截断长度。 */
const TAG_DESCRIPTION_LIMIT = 160
/** AI 标注的系统提示词。 */
const TAG_SYSTEM_PROMPT = '你是开发者技能库的分类助手。只输出 JSON，不要解释。'
/** 一次标注请求的硬超时（毫秒）。 */
const TAG_REQUEST_TIMEOUT_MS = 60_000
/** 因 busy（清单扫描 / 统计扫描 / Agent 运行中）而推迟的空闲重试间隔。 */
const TAG_BUSY_RETRY_MS = 30_000
/** 一轮预算用完后仍有待标注技能时的续跑间隔（5 分钟）。 */
const TAG_CONTINUE_DELAY_MS = 5 * 60_000
/** autoTagEnabled 等配置的默认值（会被 apply 的 config 覆盖并夹取范围）。 */
const TAG_CONFIG_DEFAULTS = Object.freeze({
  autoTagEnabled: true,
  tagBatchSize: 8,
  tagMaxPerRun: 16,
  tagDelayMs: 45_000,
  tagIntervalMs: 90_000,
  tagBackoffMs: 600_000,
})
/** 标签错误信息落 payload 时的最大长度。 */
const TAG_ERROR_LIMIT = 200

/* ---- 更新检测 / 更新（契约 v4） ---- */
/** 更新方式。 */
const UPDATE_METHODS = new Set(['script', 'git', 'git-project', 'metadata', 'none', 'bundled'])
/** 更新状态（`checking` 只是运行中的瞬态，落盘读取时会回退为 unknown）。 */
const UPDATE_STATES = new Set(['unknown', 'checking', 'up-to-date', 'available', 'updated', 'failed', 'not-applicable'])
/** 版本号形状（x.y / x.y.z，可带预发布后缀）。 */
const VERSION_PATTERN = /^\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?$/
/** 从文本里提取三段的版本号。 */
const VERSION_TRIPLE_IN_TEXT = /(\d+\.\d+\.\d+)/g
/** README 里可用的 GitHub 仓库链接。 */
const GITHUB_URL_PATTERN = /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/g
/** update.message 的最大长度。 */
const MAX_UPDATE_MESSAGE = 300
/** 更新脚本 check / apply 的超时。 */
const SCRIPT_UPDATE_TIMEOUT_MS = 60_000
/** git fetch 的超时。 */
const GIT_FETCH_TIMEOUT_MS = 60_000
/** git pull 的超时。 */
const GIT_PULL_TIMEOUT_MS = 120_000
/** git ls-remote 的超时。 */
const LS_REMOTE_TIMEOUT_MS = 30_000
/** Python 解释器候选（Windows 上 `python3` 常是应用商店占位符，优先 python）。 */
const PYTHON_INTERPRETERS = process.platform === 'win32' ? ['python', 'python3'] : ['python3', 'python']
/** known 里属于更新检测缓存的字段（清单刷新时按路径继承）。 */
const UPDATE_CACHE_KEYS = ['updateMethod', 'repoUrl', 'scriptPath', 'canApply', 'version', 'updateDetectPath']

/* ------------------------------------------------------------------ *
 * 通用工具
 * ------------------------------------------------------------------ */

/** 判断是否是契约允许的技能名。 */
function isSkillName(value) {
  return typeof value === 'string' && NAME_PATTERN.test(value)
}

/** 判断是否是注册表能接受的严格技能名。 */
function isRegistrySkillName(value) {
  return typeof value === 'string' && REGISTRY_NAME_PATTERN.test(value)
}

/** 判断是否是合法的会话 id。 */
function isSessionId(value) {
  return typeof value === 'string' && SESSION_ID_PATTERN.test(value)
}

/** 判断是否是合法的工作区 id。 */
function isWorkspaceId(value) {
  return typeof value === 'string' && WORKSPACE_ID_PATTERN.test(value)
}

/** 非负安全整数收敛。 */
function toNonNegativeInt(value) {
  const num = Number(value)
  if (!Number.isFinite(num) || num <= 0) return 0
  return Math.min(Math.trunc(num), Number.MAX_SAFE_INTEGER)
}

/** 整数夹取；非法值回退默认值。 */
function clampInt(value, fallback, min, max) {
  const num = Number(value)
  if (!Number.isFinite(num)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(num)))
}

/** 文本截断（用于 lastError 等展示字段）。 */
function truncateText(value, limit) {
  const text = typeof value === 'string' ? value : value === undefined ? '' : String(value)
  return text.length > limit ? text.slice(0, limit) : text
}

/**
 * 标签文本规范（契约 v3）：trim、去前导 `#`、折叠空白、最长 24 字符。
 * @param {unknown} value - 原始标签。
 * @returns {string|undefined} 合法标签文本；非法返回 undefined。
 */
function sanitizeTagText(value) {
  if (typeof value !== 'string') return undefined
  let text = value.trim()
  if (text.length === 0) return undefined
  text = text.replace(/^#+\s*/, '')
  text = text.replace(/\s+/g, ' ').trim()
  if (text.length === 0) return undefined
  if (text.length > MAX_TAG_LENGTH) text = text.slice(0, MAX_TAG_LENGTH).trim()
  if (text.length === 0) return undefined
  return text
}

/**
 * 标签数组规范：逐项 sanitize、按小写去重、最多 limit 个。
 * @param {unknown} value - 原始数组。
 * @param {number} [limit] - 数量上限。
 * @returns {string[]|undefined} 规范化数组；value 不是数组时返回 undefined。
 */
function sanitizeTagList(value, limit = MAX_TAGS_PER_LIST) {
  if (!Array.isArray(value)) return undefined
  const result = []
  const seen = new Set()
  for (const item of value) {
    const text = sanitizeTagText(item)
    if (text === undefined) continue
    const key = text.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(text)
    if (result.length >= limit) break
  }
  return result
}

/** 标签比较键（大小写不敏感去重用）。 */
function tagKey(text) {
  return typeof text === 'string' ? text.toLowerCase() : ''
}

/**
 * 读取一次 SKILL.md 的安装 / 更新时间（每次清单扫描对同一路径最多 stat 一次）。
 * installedAt = birthtimeMs > 0 ? birthtimeMs : ctimeMs；updatedAt = mtimeMs。
 * @param {string} file - 技能指令文件。
 * @param {Map<string, object|undefined>|undefined} cache - 单次扫描内的 stat 缓存。
 * @returns {{ installedAt: number|null, updatedAt: number|null }|undefined}
 */
function fileTimes(file, cache) {
  if (typeof file !== 'string' || file.length === 0) return undefined
  if (cache !== undefined && cache.has(file)) return cache.get(file)
  let result
  try {
    const stats = fs.statSync(file)
    const birth = Number.isFinite(stats.birthtimeMs) ? Math.trunc(stats.birthtimeMs) : 0
    const ctime = Number.isFinite(stats.ctimeMs) ? Math.trunc(stats.ctimeMs) : 0
    const installed = birth > 0 ? birth : ctime
    const updated = Number.isFinite(stats.mtimeMs) ? Math.trunc(stats.mtimeMs) : 0
    result = {
      installedAt: installed > 0 ? installed : null,
      updatedAt: updated > 0 ? updated : null,
    }
  } catch {
    result = undefined
  }
  if (cache !== undefined) cache.set(file, result)
  return result
}

/** 安全的 fs.existsSync：路径非法或异常一律视为不存在。 */
function pathExists(target) {
  if (typeof target !== 'string' || target.length === 0) return false
  try {
    return fs.existsSync(target)
  } catch {
    return false
  }
}

/**
 * 规范化一个绝对/相对路径，用于比较：resolve、去尾部分隔符、统一分隔符；
 * Windows 下再做小写化（大小写不敏感）。
 * @param {string} value - 原始路径。
 * @returns {string|undefined} 规范化后的比较键。
 */
function normalizePathKey(value) {
  if (typeof value !== 'string' || value.trim().length === 0) return undefined
  try {
    let resolved = path.resolve(value.trim())
    // 去尾部分隔符（保留盘符/根目录本身）。
    while (resolved.length > 1 && (resolved.endsWith(path.sep) || resolved.endsWith('/') || resolved.endsWith('\\'))) {
      resolved = resolved.slice(0, -1)
    }
    // 统一分隔符后按平台决定大小写。
    resolved = resolved.replace(/[\\/]+/g, path.sep)
    if (process.platform === 'win32') resolved = resolved.toLowerCase()
    return resolved
  } catch {
    return undefined
  }
}

/** `DSH_HOME`：环境变量优先，缺省 `~/.dsh`。 */
function dshHome() {
  const configured = process.env.DSH_HOME
  const base = typeof configured === 'string' && configured.trim().length > 0
    ? configured.trim()
    : path.join(os.homedir(), '.dsh')
  return path.resolve(base)
}

/** `<DSH_HOME>/skill-manager/state.json`。 */
function stateFile() {
  return path.join(dshHome(), 'skill-manager', 'state.json')
}

/** `<DSH_HOME>/skill-trash`。 */
function trashDirectory() {
  return path.join(dshHome(), 'skill-trash')
}

/** 本地时间戳 `yyyyMMdd-HHmmss`，用于回收站目录名。 */
function trashStamp(date) {
  const pad = (value) => String(value).padStart(2, '0')
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '-',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('')
}

/** 从请求 URL 拆 pathname，失败返回空串。 */
function pathnameOf(url) {
  try {
    return new URL(typeof url === 'string' && url.length > 0 ? url : '/', 'http://localhost').pathname
  } catch {
    return ''
  }
}

/** 从请求 URL 拆查询参数，失败返回 null。 */
function searchParamsOf(url) {
  try {
    return new URL(typeof url === 'string' && url.length > 0 ? url : '/', 'http://localhost').searchParams
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ *
 * 更新检测工具（契约 v4 §1）
 * ------------------------------------------------------------------ */

/** 安全读取 UTF-8 文本文件。 */
function readTextFileSafe(file) {
  if (typeof file !== 'string' || file.length === 0) return undefined
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
}

/** 去掉 YAML 值两端的引号。 */
function stripYamlQuotes(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text.length >= 2) {
    const first = text[0]
    const last = text[text.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return text.slice(1, -1).trim()
  }
  return text
}

/**
 * 极简 YAML frontmatter 解析：只取 `key: value` 与一层缩进子键（metadata.*）。
 * 解析失败 / 无 frontmatter 一律返回空对象。
 * @param {string} text - SKILL.md 内容。
 * @returns {Record<string, string>} 扁平键值（子键以 `metadata.` 前缀）。
 */
function parseSkillFrontmatter(text) {
  if (typeof text !== 'string') return {}
  const lines = text.split(/\r?\n/)
  if (lines.length === 0 || lines[0].trim() !== '---') return {}
  let end = -1
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === '---') {
      end = index
      break
    }
  }
  if (end === -1) return {}
  const flat = {}
  let section
  for (let index = 1; index < end; index += 1) {
    const raw = lines[index]
    const trimmed = raw.trim()
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue
    const match = /^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(trimmed)
    if (match === null) continue
    const key = match[1].toLowerCase()
    const value = stripYamlQuotes(match[2])
    const indented = raw.length - raw.trimStart().length > 0
    if (indented && section !== undefined) {
      flat[`${section}.${key}`] = value
      continue
    }
    if (value.length > 0) flat[key] = value
    section = key
  }
  return flat
}

/** 从 frontmatter 取版本号（metadata.version 优先，其次顶层 version）。 */
function frontmatterVersion(flat) {
  const candidates = [flat['metadata.version'], flat.version]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && VERSION_PATTERN.test(candidate.trim())) return candidate.trim()
  }
  return null
}

/** 从 frontmatter 取显式仓库地址。 */
function frontmatterRepoUrl(flat) {
  const keys = [
    'metadata.repository', 'metadata.repo', 'metadata.homepage', 'metadata.source', 'metadata.url',
    'repository', 'homepage', 'source', 'url',
  ]
  for (const key of keys) {
    const candidate = flat[key]
    if (typeof candidate === 'string' && /^https?:\/\//i.test(candidate.trim())) return candidate.trim()
  }
  return null
}

/**
 * 规范化仓库地址：ssh / scp 转 https、去掉 .git 与尾部斜杠。
 * @param {unknown} raw - 原始地址。
 * @returns {string|null} 规范化地址；非法返回 null。
 */
function normalizeRepoUrl(raw) {
  if (typeof raw !== 'string') return null
  let text = raw.trim()
  if (text.length === 0) return null
  const scpMatch = /^git@([^:]+):(.+)$/.exec(text)
  if (scpMatch !== null) text = `https://${scpMatch[1]}/${scpMatch[2]}`
  else {
    const sshMatch = /^ssh:\/\/git@([^/]+)\/(.+)$/.exec(text)
    if (sshMatch !== null) text = `https://${sshMatch[1]}/${sshMatch[2]}`
  }
  if (!/^https?:\/\//i.test(text)) return null
  text = text.replace(/\.git$/i, '').replace(/[?#].*$/, '').replace(/\/+$/, '')
  return text.length > 0 ? text : null
}

/** 三段版本号（x.y / x.y.z）。 */
function parseVersionTriple(value) {
  if (typeof value !== 'string') return null
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(value.trim())
  if (match === null) return null
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)]
}

/** 比较两个三段版本号。 */
function compareVersionTriples(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index]
  }
  return 0
}

/**
 * 从脚本 stdout 里挑一个版本号：优先高于当前版本的、最大的三段版本号；
 * 找不到候选时返回 null。
 * @param {string} text - stdout。
 * @param {string|null} currentVersion - 当前版本。
 * @returns {string|null}
 */
function parseLatestVersion(text, currentVersion) {
  const candidates = []
  for (const match of String(text).matchAll(VERSION_TRIPLE_IN_TEXT)) candidates.push(match[1])
  if (candidates.length === 0) return null
  const currentTriple = currentVersion === null ? null : parseVersionTriple(currentVersion)
  if (currentTriple === null) return candidates[0]
  let best = null
  for (const candidate of candidates) {
    const triple = parseVersionTriple(candidate)
    if (triple === null) continue
    if (compareVersionTriples(triple, currentTriple) <= 0) continue
    if (best === null || compareVersionTriples(triple, best.triple) > 0) best = { text: candidate, triple }
  }
  return best === null ? candidates[0] : best.text
}

/**
 * 从 `git ls-remote --tags --refs` 输出里取最高版本标签（去掉前导 v）。
 * @param {string} stdout - ls-remote 输出。
 * @returns {string|null}
 */
function highestTagVersion(stdout) {
  let best = null
  for (const line of String(stdout).split(/\r?\n/)) {
    const match = /refs\/tags\/(\S+)\s*$/.exec(line.trim())
    if (match === null) continue
    const raw = match[1].replace(/^v/i, '')
    if (!VERSION_PATTERN.test(raw)) continue
    const triple = parseVersionTriple(raw)
    if (triple === null) continue
    if (best === null || compareVersionTriples(triple, best.triple) > 0) best = { text: raw, triple }
  }
  return best === null ? null : best.text
}

/** 解析 `.git/config` 里的 origin url。 */
function gitConfigOriginUrl(gitDir) {
  const text = readTextFileSafe(path.join(gitDir, 'config'))
  if (typeof text !== 'string') return null
  const section = /\[remote\s+"origin"\]\s*\n([\s\S]*?)(?=\n\[|$)/i.exec(text)
  if (section === null) return null
  const remoteMatch = /^\s*url\s*=\s*(.+)$/im.exec(section[1])
  return remoteMatch === null ? null : normalizeRepoUrl(remoteMatch[1])
}

/** 解析 `.git`（目录或 worktree 的 gitdir 指针文件），返回真实 git 目录。 */
function resolveGitDir(repoRoot) {
  const candidate = path.join(repoRoot, '.git')
  try {
    const stats = fs.statSync(candidate)
    if (stats.isDirectory()) return candidate
    if (stats.isFile()) {
      const text = readTextFileSafe(candidate) ?? ''
      const pointer = /^gitdir:\s*(.+)$/im.exec(text)
      if (pointer !== null) return path.resolve(repoRoot, pointer[1].trim())
    }
  } catch {
    /* 不存在 */
  }
  return undefined
}

/**
 * 从技能目录向上最多 4 层找 git 仓库。
 * @param {string} startDir - 技能目录。
 * @param {number} [maxLevels] - 最多上溯层数。
 * @returns {{ repoRoot: string, gitDir: string }|undefined}
 */
function findGitRepo(startDir, maxLevels = 4) {
  let dir = path.resolve(startDir)
  for (let level = 0; level <= maxLevels; level += 1) {
    const gitDir = resolveGitDir(dir)
    if (gitDir !== undefined) return { repoRoot: dir, gitDir }
    const parent = path.dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
  return undefined
}

/** 检测技能目录下的更新脚本（.py 优先）。 */
function findUpdateScript(skillDir) {
  const candidates = [
    { relative: path.join('scripts', 'check_update.py'), kind: 'py' },
    { relative: 'check_update.py', kind: 'py' },
    { relative: path.join('scripts', 'check_update.sh'), kind: 'sh' },
    { relative: 'check_update.sh', kind: 'sh' },
  ]
  for (const candidate of candidates) {
    const absolute = path.join(skillDir, candidate.relative)
    if (pathExists(absolute)) return { scriptPath: absolute, kind: candidate.kind }
  }
  return undefined
}

/** 从 README 里找唯一 GitHub 仓库地址（0 个或多个不同候选时返回 null）。 */
function readmeRepoUrl(skillDir) {
  for (const name of ['README.md', 'readme.md', 'README.MD']) {
    const text = readTextFileSafe(path.join(skillDir, name))
    if (typeof text !== 'string') continue
    const matches = [...text.matchAll(GITHUB_URL_PATTERN)].map((match) => normalizeRepoUrl(match[0]))
    const distinct = [...new Set(matches.filter((url) => url !== null).map((url) => url.toLowerCase()))]
    return distinct.length === 1 ? distinct[0] : null
  }
  return null
}

/**
 * 检测一个已知技能的更新方式（纯同步、不抛异常、结果缓存进 known）。
 * @param {{ path?: string, source?: string }} entry - state.known 条目。
 * @returns {{ updateMethod: string, repoUrl: string|null, scriptPath: string|null, canApply: boolean, version: string|null }}
 */
function detectUpdateInfo(entry) {
  const fallback = { updateMethod: 'none', repoUrl: null, scriptPath: null, canApply: false, version: null }
  try {
    if (entry === null || typeof entry !== 'object') return fallback
    if (typeof entry.path !== 'string' || entry.path.length === 0) return fallback
    const file = entry.path
    const skillDir = path.dirname(file)
    const flat = parseSkillFrontmatter(readTextFileSafe(file) ?? '')
    const version = frontmatterVersion(flat)
    const explicitRepo = frontmatterRepoUrl(flat)

    // 内置技能（node_modules / bundled）只展示，不检测、不执行任何命令。
    if (entry.source === 'bundled' || isInstalledPackagePath(file)) {
      return { updateMethod: 'bundled', repoUrl: explicitRepo, scriptPath: null, canApply: false, version }
    }

    // 1) 更新脚本（.py 优先；.sh 在本机不支持）。
    const script = findUpdateScript(skillDir)
    if (script !== undefined) {
      if (script.kind === 'sh') {
        return { updateMethod: 'none', repoUrl: explicitRepo, scriptPath: script.scriptPath, canApply: false, version }
      }
      const text = readTextFileSafe(script.scriptPath) ?? ''
      return {
        updateMethod: 'script',
        repoUrl: explicitRepo,
        scriptPath: script.scriptPath,
        canApply: text.includes('--update'),
        version,
      }
    }

    // 2) git 仓库：技能目录自身 / 其父目录 = 技能自己的仓库；更上层 = 上级项目仓库。
    const repo = findGitRepo(skillDir)
    if (repo !== undefined) {
      const isOwnRepo = repo.repoRoot === skillDir || repo.repoRoot === path.dirname(skillDir)
      return {
        updateMethod: isOwnRepo ? 'git' : 'git-project',
        repoUrl: gitConfigOriginUrl(repo.gitDir) ?? explicitRepo,
        scriptPath: null,
        canApply: isOwnRepo,
        version,
      }
    }

    // 3) 仅 metadata：frontmatter 版本 / 显式仓库地址，或 README 里唯一仓库链接。
    const readmeUrl = explicitRepo === null ? readmeRepoUrl(skillDir) : null
    if (explicitRepo !== null || readmeUrl !== null) {
      return { updateMethod: 'metadata', repoUrl: explicitRepo ?? readmeUrl, scriptPath: null, canApply: false, version }
    }
    // 只有版本、没有任何仓库地址：保留版本展示，但菜单按「无关联代码仓」处理。
    if (version !== null) {
      return { updateMethod: 'none', repoUrl: null, scriptPath: null, canApply: false, version }
    }
    return fallback
  } catch {
    return fallback
  }
}

/* ------------------------------------------------------------------ *
 * 状态文件
 * ------------------------------------------------------------------ */

/** 默认（空）状态。 */
function emptyState() {
  return {
    version: STATE_VERSION,
    disabled: [],
    bindings: {},
    known: {},
    tags: {},
    updates: {},
    stats: { updatedAt: 0, sessions: {} },
  }
}

/**
 * 判定路径是否落在任意 node_modules 里。
 * 安装目录（DSH 自身、外部插件包）随附的技能由包管理，删除会破坏安装，
 * 因此这类路径一律按 "bundled" 处理：界面显示"内置"，删除被拒绝。
 * @param {unknown} target - 技能指令文件的绝对路径。
 * @returns {boolean} 是否位于 node_modules 内。
 */
function isInstalledPackagePath(target) {
  return typeof target === 'string' && target.length > 0 && /[\\/]node_modules[\\/]/i.test(target)
}

/** 校验并收敛一条 known 记录，非法时返回 null。 */
function sanitizeKnownEntry(raw) {
  if (raw === null || typeof raw !== 'object') return null
  const entry = {
    description: typeof raw.description === 'string' ? raw.description : '',
    source: typeof raw.source === 'string' && raw.source.length > 0 ? raw.source : 'unknown',
  }
  if (typeof raw.path === 'string' && raw.path.length > 0) entry.path = raw.path
  if (typeof raw.whenToUse === 'string' && raw.whenToUse.length > 0) entry.whenToUse = raw.whenToUse
  if (typeof raw.provider === 'string' && raw.provider.length > 0) entry.provider = raw.provider
  if (isInstalledPackagePath(entry.path)) entry.source = 'bundled'
  // 契约 v3：安装 / 更新时间（未知保持省略 → payload 里为 null）。
  const installedAt = toNonNegativeInt(raw.installedAt)
  if (installedAt > 0) entry.installedAt = installedAt
  const updatedAt = toNonNegativeInt(raw.updatedAt)
  if (updatedAt > 0) entry.updatedAt = updatedAt
  // 契约 v4：更新检测缓存（路径不变时直接复用，避免重复扫盘）。
  if (typeof raw.updateMethod === 'string' && UPDATE_METHODS.has(raw.updateMethod)) entry.updateMethod = raw.updateMethod
  if (typeof raw.repoUrl === 'string' && raw.repoUrl.length > 0) entry.repoUrl = raw.repoUrl
  if (typeof raw.scriptPath === 'string' && raw.scriptPath.length > 0) entry.scriptPath = raw.scriptPath
  if (typeof raw.canApply === 'boolean') entry.canApply = raw.canApply
  if (typeof raw.version === 'string' && VERSION_PATTERN.test(raw.version)) entry.version = raw.version
  if (typeof raw.updateDetectPath === 'string' && raw.updateDetectPath.length > 0) entry.updateDetectPath = raw.updateDetectPath
  return entry
}

/** 比较两份 known 缓存是否等价（用于决定是否需要落盘 / 失效目录）。 */
function sameKnown(left, right) {
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  if (leftKeys.length !== rightKeys.length) return false
  for (const key of leftKeys) {
    const before = left[key]
    const after = right[key]
    if (after === undefined) return false
    if (before.description !== after.description) return false
    if (before.source !== after.source) return false
    if (before.path !== after.path) return false
    if (before.whenToUse !== after.whenToUse) return false
    if (before.provider !== after.provider) return false
    if (before.installedAt !== after.installedAt) return false
    if (before.updatedAt !== after.updatedAt) return false
    // 检测缓存字段（契约 v4）：变化时同样需要落盘。
    if (before.updateMethod !== after.updateMethod) return false
    if (before.repoUrl !== after.repoUrl) return false
    if (before.scriptPath !== after.scriptPath) return false
    if (before.canApply !== after.canApply) return false
    if (before.version !== after.version) return false
    if (before.updateDetectPath !== after.updateDetectPath) return false
  }
  return true
}

/** 校验并收敛一条标签记录（ai / user / muted / aiAt）。 */
function sanitizeTagEntry(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const entry = {
    ai: sanitizeTagList(raw.ai) ?? [],
    user: sanitizeTagList(raw.user) ?? [],
    muted: sanitizeTagList(raw.muted) ?? [],
    aiAt: toNonNegativeInt(raw.aiAt),
  }
  // 全空记录不落盘。
  if (entry.ai.length === 0 && entry.user.length === 0 && entry.muted.length === 0) return null
  return entry
}

/** 校验并收敛一条更新记录（契约 v4）；损坏/空记录返回 null。 */
function sanitizeUpdateRecord(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const stateValue = typeof raw.state === 'string' && UPDATE_STATES.has(raw.state) ? raw.state : 'unknown'
  const record = {
    // `checking` 是运行态；落盘后读到说明上次运行被中断，回退为 unknown。
    state: stateValue === 'checking' ? 'unknown' : stateValue,
    latest: typeof raw.latest === 'string' && raw.latest.length > 0 ? raw.latest.slice(0, 100) : null,
    message: typeof raw.message === 'string' && raw.message.length > 0 ? raw.message.slice(0, MAX_UPDATE_MESSAGE) : null,
    checkedAt: toNonNegativeInt(raw.checkedAt),
  }
  if (record.state === 'unknown' && record.latest === null && record.message === null && record.checkedAt === 0) return null
  return record
}

/** 把磁盘上的任意 JSON 收敛为合法状态；损坏时回退默认值。 */
function sanitizeState(raw) {
  const state = emptyState()
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return state

  // 契约 v3：只有当前版本的 bindings 才可信（v1 存 session id、v2 存 workspace id，
  // 读取旧文件时一律丢弃）；known / stats / disabled 原样保留。
  const currentVersion = raw.version === STATE_VERSION

  if (Array.isArray(raw.disabled)) {
    const names = new Set()
    for (const value of raw.disabled) if (isSkillName(value)) names.add(value)
    state.disabled = [...names].sort()
  }

  if (currentVersion && raw.bindings !== null && typeof raw.bindings === 'object' && !Array.isArray(raw.bindings)) {
    for (const [skillName, value] of Object.entries(raw.bindings)) {
      if (!isSkillName(skillName) || !Array.isArray(value)) continue
      const ids = new Set()
      for (const id of value) if (isWorkspaceId(id)) ids.add(id)
      const list = [...ids].slice(0, MAX_BINDINGS)
      if (list.length > 0) state.bindings[skillName] = list
    }
  }

  if (raw.known !== null && typeof raw.known === 'object' && !Array.isArray(raw.known)) {
    for (const [skillName, value] of Object.entries(raw.known)) {
      if (!isSkillName(skillName)) continue
      const entry = sanitizeKnownEntry(value)
      if (entry !== null) state.known[skillName] = entry
    }
  }

  const stats = raw.stats
  if (stats !== null && typeof stats === 'object' && !Array.isArray(stats)) {
    state.stats.updatedAt = toNonNegativeInt(stats.updatedAt)
    const sessions = stats.sessions
    if (sessions !== null && typeof sessions === 'object' && !Array.isArray(sessions)) {
      for (const [sessionId, value] of Object.entries(sessions)) {
        if (!isSessionId(sessionId) || value === null || typeof value !== 'object') continue
        const skills = {}
        if (value.skills !== null && typeof value.skills === 'object' && !Array.isArray(value.skills)) {
          for (const [skillName, count] of Object.entries(value.skills)) {
            if (!isSkillName(skillName)) continue
            const hits = toNonNegativeInt(count)
            if (hits > 0) skills[skillName] = hits
          }
        }
        state.stats.sessions[sessionId] = {
          sig: typeof value.sig === 'string' ? value.sig : '',
          lastUsedAt: toNonNegativeInt(value.lastUsedAt),
          skills,
        }
      }
    }
  }

  // 契约 v3：tags 只从同版本文件读取；v1/v2 迁移后 tags 从空开始。
  if (currentVersion && raw.tags !== null && typeof raw.tags === 'object' && !Array.isArray(raw.tags)) {
    for (const [skillName, value] of Object.entries(raw.tags)) {
      if (!isSkillName(skillName)) continue
      const entry = sanitizeTagEntry(value)
      if (entry !== null) state.tags[skillName] = entry
    }
  }

  // 契约 v4：更新记录（与 tags 同规则：只读同版本文件、未知技能名在清单刷新时剪除）。
  if (currentVersion && raw.updates !== null && typeof raw.updates === 'object' && !Array.isArray(raw.updates)) {
    for (const [skillName, value] of Object.entries(raw.updates)) {
      if (!isSkillName(skillName)) continue
      const record = sanitizeUpdateRecord(value)
      if (record !== null) state.updates[skillName] = record
    }
  }

  return state
}

/** 读取状态文件（同步、损坏安全）。 */
function loadState(log) {
  const file = stateFile()
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (err) {
    // 首次运行 / 文件缺失都属于正常情况。
    if (err && err.code !== 'ENOENT') log.warn(`读取状态文件失败：${err.message}`)
    return emptyState()
  }
  try {
    return sanitizeState(JSON.parse(text))
  } catch (err) {
    log.warn(`状态文件已损坏，回退为默认值：${err.message}`)
    return emptyState()
  }
}

/** 原子写：先写 `.tmp` 再 rename。失败只记录日志，绝不抛出。 */
function writeStateFile(snapshot, log) {
  const file = stateFile()
  const temporary = `${file}.tmp`
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(temporary, JSON.stringify(snapshot), 'utf8')
    fs.renameSync(temporary, file)
    return true
  } catch (err) {
    log.warn(`写入状态文件失败：${err.message}`)
    try {
      fs.rmSync(temporary, { force: true })
    } catch {
      /* 清理失败可忽略 */
    }
    return false
  }
}

/* ------------------------------------------------------------------ *
 * HTTP 错误
 * ------------------------------------------------------------------ */

/** 带状态码的错误，handler 统一转成 `{ ok: false, error }`。 */
class HttpError extends Error {
  constructor(status, code, message) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.code = code
  }
}

/** 便捷构造 400。 */
function invalidRequest(message) {
  return new HttpError(400, 'invalid-request', message)
}

/** 便捷构造 404。 */
function notFound(message) {
  return new HttpError(404, 'not-found', message)
}

/** 便捷构造 403。 */
function forbidden(message) {
  return new HttpError(403, 'forbidden', message)
}

/* ------------------------------------------------------------------ *
 * 插件入口
 * ------------------------------------------------------------------ */

/**
 * 挂载宿主半边。
 * @param {object} ctx - Cordis 上下文（含 skills / webServer 服务）。
 * @param {unknown} config - 插件配置（本插件未使用）。
 */
export function apply(ctx, config) {
  void config

  /* ---------------------------- 基础设施 ---------------------------- */

  const log = createLogger(ctx)

  /** 读取任意可选服务，缺失或抛错都返回 undefined。 */
  function service(serviceName) {
    try {
      if (ctx && typeof ctx.get === 'function') return ctx.get(serviceName)
    } catch {
      /* 服务尚未提供：按缺失处理 */
    }
    return undefined
  }

  /** 包装 ctx.effect；桩上下文没有 effect 时直接执行。 */
  function registerEffect(execute, label) {
    if (ctx && typeof ctx.effect === 'function') return ctx.effect(execute, label)
    return execute()
  }

  /* ---------------------------- 内存状态 ---------------------------- */

  const state = loadState(log)

  /** live Agent 作用域内注册的 provider：sessionId -> { agent, disposer, control }。 */
  const agentProviders = new Map()
  /** 所有存活 provider registration 的 control，统一用于失效技能目录。 */
  const liveProviderControls = new Set()
  /** 「agent 作用域不可用」只告警一次，避免刷屏。 */
  let warnedAgentScopeMissing = false
  /** skills/change / agent/created 触发的清单刷新防抖计时器。 */
  let inventoryRefreshTimer = null

  /** 统计扫描状态（scanning 同时用于前端轮询与并发合并）。 */
  const scanState = { scanning: false, pending: null, totalSessions: 0 }

  /** 技能清单（= state.known）刷新状态。 */
  let inventoryReady = false
  let inventoryUpdatedAt = 0
  let inventoryPending = null
  let inventoryRetryAt = 0
  /** 扫描进行中被请求再刷新一次（合并到本轮结束后的一次补扫）。 */
  let inventoryRefreshRequested = false

  /** workspaceRegistry.list() 的规范化匹配缓存：{ at, entries }，TTL 10s + 事件失效。 */
  let workspaceCache = { at: 0, entries: null }

  /** 把内存状态序列化为落盘结构（键排序，便于 diff）。 */
  function serializeState() {
    const disabled = [...new Set(state.disabled.filter(isSkillName))].sort()

    const bindings = {}
    for (const skillName of Object.keys(state.bindings).sort()) {
      if (!isSkillName(skillName) || !Array.isArray(state.bindings[skillName])) continue
      const list = [...new Set(state.bindings[skillName].filter(isWorkspaceId))].slice(0, MAX_BINDINGS)
      if (list.length > 0) bindings[skillName] = list
    }

    const known = {}
    for (const skillName of Object.keys(state.known).sort()) {
      const entry = sanitizeKnownEntry(state.known[skillName])
      if (entry !== null) known[skillName] = entry
    }

    const tags = {}
    for (const skillName of Object.keys(state.tags).sort()) {
      const entry = sanitizeTagEntry(state.tags[skillName])
      if (entry !== null) tags[skillName] = entry
    }

    const sessions = {}
    for (const sessionId of Object.keys(state.stats.sessions).sort()) {
      const record = state.stats.sessions[sessionId]
      if (!record) continue
      const skills = {}
      for (const skillName of Object.keys(record.skills ?? {}).sort()) {
        const hits = toNonNegativeInt(record.skills[skillName])
        if (hits > 0) skills[skillName] = hits
      }
      sessions[sessionId] = {
        sig: typeof record.sig === 'string' ? record.sig : '',
        lastUsedAt: toNonNegativeInt(record.lastUsedAt),
        skills,
      }
    }

    const updates = {}
    for (const skillName of Object.keys(state.updates).sort()) {
      const record = sanitizeUpdateRecord(state.updates[skillName])
      if (record !== null) updates[skillName] = record
    }

    return {
      version: STATE_VERSION,
      disabled,
      bindings,
      known,
      tags,
      updates,
      stats: { updatedAt: toNonNegativeInt(state.stats.updatedAt), sessions },
    }
  }

  /** 持久化当前状态（同步、出错不抛）。 */
  function persist() {
    return writeStateFile(serializeState(), log)
  }

  /**
   * 让技能目录缓存失效（模型侧技能列表随之刷新），并丢弃工作区匹配缓存。
   * registry 的 invalidate 是 registry 级的，任一存活 registration 的 control 都足以
   * 清空缓存；这里全部调用，保证作用域 provider 被替换后仍然生效。
   */
  function invalidate() {
    invalidateWorkspaceCache()
    for (const control of liveProviderControls) {
      try {
        control.invalidate()
      } catch (err) {
        log.warn(`失效技能目录失败：${err.message}`)
      }
    }
  }

  /* ------------------------ 技能清单（§4.3） ------------------------ */

  /** 技能清单扫描与 debug 解析共用的 cwd（缺省目录服务时返回 undefined）。 */
  function inventoryCwd() {
    const workingDirectory = service('workingDirectory')
    return workingDirectory && typeof workingDirectory.defaultDirectory === 'string'
      ? workingDirectory.defaultDirectory
      : undefined
  }

  /* ---------------------- 工作区解析（契约 v2 §A） ---------------------- */

  /** 读取可选的 workspaceRegistry 服务。 */
  function workspaceRegistryService() {
    const registry = service('workspaceRegistry')
    return registry && typeof registry.list === 'function' ? registry : undefined
  }

  /** 丢弃工作区匹配缓存（skills/change、清单刷新、状态变更后调用）。 */
  function invalidateWorkspaceCache() {
    workspaceCache = { at: 0, entries: null }
  }

  /**
   * 读取并规范化 `workspaceRegistry.list()`（registry 顺序的同步投影）。
   * 缓存 10s；list 抛错时返回空数组（只影响匹配，不影响其他功能）。
   * @returns {{ workspace: object, key: string }[]}
   */
  function workspaceEntries() {
    const now = Date.now()
    if (workspaceCache.entries !== null && now - workspaceCache.at <= WORKSPACE_CACHE_MS) {
      return workspaceCache.entries
    }
    const registry = workspaceRegistryService()
    const entries = []
    if (registry) {
      let list = []
      try {
        list = registry.list()
      } catch (err) {
        log.warn(`读取工作区清单失败：${err.message}`)
        list = []
      }
      for (const workspace of Array.isArray(list) ? list : []) {
        if (workspace === null || typeof workspace !== 'object') continue
        if (!isWorkspaceId(workspace.id)) continue
        const key = normalizePathKey(workspace.path)
        if (key === undefined) continue
        entries.push({ workspace, key })
      }
    }
    workspaceCache = { at: now, entries }
    return entries
  }

  /**
   * 把 cwd 解析到工作区：先精确匹配，再最长路径前缀匹配（cwd 可以是工作区子目录）。
   * 纯内存、永不抛出；无 registry / 无匹配返回 undefined。
   * @param {string|undefined} cwd - 会话或目录路径。
   * @returns {object|undefined} Workspace。
   */
  function workspaceForCwd(cwd) {
    try {
      const target = normalizePathKey(cwd)
      if (target === undefined) return undefined
      const entries = workspaceEntries()
      let best
      for (const entry of entries) {
        if (entry.key === target) return entry.workspace
        if (target.startsWith(entry.key + path.sep)) {
          if (best === undefined || entry.key.length > best.key.length) best = entry
        }
      }
      return best === undefined ? undefined : best.workspace
    } catch {
      return undefined
    }
  }

  /** 从技能 lookup options 推导 cwd（优先 options.cwd，其次 Agent 的会话目录）。 */
  function cwdFromLookupOptions(options) {
    try {
      if (options !== null && typeof options === 'object') {
        const direct = options.cwd
        if (typeof direct === 'string' && direct.length > 0) return direct
        const agent = options.scope
        if (agent !== null && typeof agent === 'object' && agent.session) {
          const workingDirectory = service('workingDirectory')
          if (workingDirectory && typeof workingDirectory.get === 'function') {
            const resolved = workingDirectory.get(agent.session)
            if (typeof resolved === 'string' && resolved.length > 0) return resolved
          }
        }
      }
    } catch (err) {
      log.warn(`推导技能查找目录失败：${err.message}`)
    }
    return undefined
  }

  /** 某个 Agent 的有效 cwd（清单扫描用；缺失时退回部署默认目录）。 */
  function agentCwd(agent) {
    try {
      const workingDirectory = service('workingDirectory')
      if (workingDirectory && typeof workingDirectory.get === 'function' && agent && agent.session) {
        const resolved = workingDirectory.get(agent.session)
        if (typeof resolved === 'string' && resolved.length > 0) return resolved
      }
    } catch {
      /* 缺失时退回默认目录 */
    }
    return inventoryCwd()
  }

  /**
   * 推断「当前工作区」：先看部署默认目录，再看任一 live Agent 的工作目录。
   * 面板是全局页面，没有会话绑定，这个值只用于界面上的「当前」提示。
   * @returns {object|undefined} 命中的 Workspace。
   */
  function currentWorkspaceOf() {
    const direct = workspaceForCwd(inventoryCwd())
    if (direct !== undefined) return direct
    try {
      const agents = service('agents')
      const liveAgents = agents && typeof agents.list === 'function' ? agents.list() : []
      for (const agent of Array.isArray(liveAgents) ? liveAgents : []) {
        const workspace = workspaceForCwd(agentCwd(agent))
        if (workspace !== undefined) return workspace
      }
    } catch {
      /* 推断失败时保持「无当前工作区」 */
    }
    return undefined
  }

  /**
   * 把一份快照里的真实技能合并进 known 候选（跳过本插件的影子项）。
   * 契约 v3：每条记录带一次 fs.statSync（同一次扫描内按路径缓存），
   * 记录 installedAt（birthtime，缺失回退 ctime）与 updatedAt（mtime）。
   * @param {object} snapshot - 注册表快照。
   * @param {object} target - 合并目标（known 候选）。
   * @param {Map<string, object|undefined>} [statCache] - 单次扫描内的 stat 缓存。
   */
  function collectSummaryEntries(snapshot, target, statCache) {
    const summaries = Array.isArray(snapshot?.skills) ? snapshot.skills : []
    for (const summary of summaries) {
      if (summary === null || typeof summary !== 'object') continue
      if (summary.provider === PROVIDER_NAME) continue
      const skillName = summary.name
      if (!isSkillName(skillName)) continue
      const entry = {
        description: typeof summary.description === 'string' ? summary.description : '',
        source: typeof summary.source === 'string' && summary.source.length > 0 ? summary.source : 'unknown',
      }
      if (typeof summary.path === 'string' && summary.path.length > 0) {
        entry.path = summary.path
        const times = fileTimes(summary.path, statCache)
        if (times !== undefined) {
          if (times.installedAt !== null) entry.installedAt = times.installedAt
          if (times.updatedAt !== null) entry.updatedAt = times.updatedAt
        }
      }
      if (typeof summary.whenToUse === 'string' && summary.whenToUse.length > 0) entry.whenToUse = summary.whenToUse
      if (typeof summary.provider === 'string' && summary.provider.length > 0) entry.provider = summary.provider
      // 安装目录随附的技能（preset 以 custom 根挂载）按内置展示，且不可删除。
      if (isInstalledPackagePath(entry.path)) entry.source = 'bundled'
      target[skillName] = entry
    }
  }

  /** 清单扫描覆盖的 cwd 集合：工作区路径（registry 顺序，≤12）∪ 部署默认目录。 */
  function inventoryCwds() {
    const cwds = []
    const seen = new Set()
    const add = (candidate) => {
      const resolved = normalizePathKey(candidate)
      if (resolved === undefined || seen.has(resolved)) return
      seen.add(resolved)
      try {
        cwds.push(path.resolve(candidate.trim()))
      } catch {
        /* 非法路径跳过 */
      }
    }
    try {
      const registry = workspaceRegistryService()
      const list = registry && typeof registry.list === 'function' ? registry.list() : []
      for (const workspace of (Array.isArray(list) ? list : []).slice(0, MAX_INVENTORY_WORKSPACE_CWDS)) {
        if (workspace === null || typeof workspace !== 'object') continue
        if (typeof workspace.path === 'string' && workspace.path.length > 0) add(workspace.path)
      }
    } catch (err) {
      log.warn(`读取工作区路径失败：${err.message}`)
    }
    const defaultCwd = inventoryCwd()
    if (typeof defaultCwd === 'string' && defaultCwd.length > 0) add(defaultCwd)
    return cwds
  }

  /**
   * 收集所有可见作用域 × 所有项目根的技能清单：
   *   1. global：每个工作区 cwd / 默认 cwd 各扫一次；
   *   2. 每个可用 agent preset：只租一次作用域，对所有 cwd 扫描；
   *   3. 每个 live Agent：cwd 归一到它所属工作区根（否则默认目录）。
   * 每个来源独立容错：失败 / 不完整 / 超出快照预算只计数并记日志，绝不因此清空旧 known。
   * @returns {Promise<{ entries: object, allComplete: boolean }>}
   */
  async function collectInventorySources() {
    // 每次清单扫描都重新读取工作区投影（契约 §A：清单刷新时失效缓存）。
    invalidateWorkspaceCache()
    const cwds = inventoryCwds()
    const fallbackCwd = inventoryCwd()
    const entries = {}
    const statCache = new Map()
    let sources = 0
    let failed = 0
    let incomplete = 0
    let skipped = 0
    let budgetWarned = false
    let snapshotBudget = MAX_INVENTORY_SNAPSHOTS

    const takeBudget = () => {
      if (snapshotBudget > 0) {
        snapshotBudget -= 1
        return true
      }
      if (!budgetWarned) {
        budgetWarned = true
        log.warn(`技能清单来源超过 ${MAX_INVENTORY_SNAPSHOTS} 个快照上限，已跳过其余来源`)
      }
      skipped += 1
      return false
    }

    /** 读取一个 (cwd, scope) 的快照并合并。 */
    const addSnapshot = async (sourceLabel, scope, cwd) => {
      if (!takeBudget()) return
      sources += 1
      const options = {}
      if (typeof cwd === 'string' && cwd.length > 0) options.cwd = cwd
      if (scope !== undefined) options.scope = scope
      try {
        const snapshot = await ctx.skills.snapshot(options)
        collectSummaryEntries(snapshot, entries, statCache)
        if (!snapshot || snapshot.complete === false) incomplete += 1
      } catch (err) {
        failed += 1
        log.warn(`扫描技能来源 ${sourceLabel} 失败：${err.message}`)
      }
    }

    /** 对全部项目根各扫一次。 */
    const scanAllCwds = async (labelPrefix, scope) => {
      for (const cwd of cwds) await addSnapshot(`${labelPrefix}:${cwd}`, scope, cwd)
    }

    // 1) global 层：部署级 + 项目级技能（按 cwd 区分）。
    await scanAllCwds('global', undefined)

    // 2) agent preset 作用域：preset 内挂载的 skill-filesystem 只在该作用域可见。
    const presets = service('agentPresets')
    const presetServiceAvailable = Boolean(
      presets && typeof presets.list === 'function' && typeof presets.acquireScope === 'function',
    )
    if (presetServiceAvailable) {
      let presetList = []
      try {
        presetList = await presets.list()
      } catch (err) {
        failed += 1
        log.warn(`读取 agent preset 清单失败：${err.message}`)
      }
      const presetIds = (Array.isArray(presetList) ? presetList : [])
        .filter((preset) => preset && typeof preset.id === 'string' && preset.id.length > 0 && typeof preset.broken !== 'string')
        .map((preset) => preset.id)
        .slice(0, MAX_INVENTORY_PRESETS)
      for (const presetId of presetIds) {
        let lease
        try {
          lease = await presets.acquireScope(presetId)
          if (!lease) continue
          await scanAllCwds(`preset:${presetId}`, lease.key)
        } catch (err) {
          failed += 1
          log.warn(`读取 agent preset "${presetId}" 作用域失败：${err.message}`)
        } finally {
          try {
            if (lease && typeof lease[Symbol.asyncDispose] === 'function') await lease[Symbol.asyncDispose]()
          } catch (err) {
            log.warn(`释放 agent preset "${presetId}" 租约失败：${err.message}`)
          }
        }
      }
    }

    // 3) live Agent 作用域：用该 Agent 所属工作区根（否则默认目录）。
    const agents = service('agents')
    let liveAgents = []
    try {
      liveAgents = agents && typeof agents.list === 'function' ? agents.list() : []
    } catch (err) {
      failed += 1
      log.warn(`列出 live Agent 失败：${err.message}`)
    }
    for (const agent of (Array.isArray(liveAgents) ? liveAgents : []).slice(0, MAX_INVENTORY_AGENTS)) {
      if (agent === null || typeof agent !== 'object') continue
      const workspace = workspaceForCwd(agentCwd(agent))
      const cwd = workspace && typeof workspace.path === 'string' && workspace.path.length > 0
        ? workspace.path
        : fallbackCwd
      await addSnapshot(`agent:${agent.id ?? '?'}`, agent, cwd)
    }

    // 只有「preset 服务可用 + 全部来源完整成功 + 没有因预算跳过」时才允许剪枝；
    // 否则宁可保留旧条目，也不重演「user 技能被 global 视图吞掉」的缺陷。
    const allComplete = presetServiceAvailable && sources > 0 && failed === 0 && incomplete === 0 && skipped === 0
    return { entries, allComplete }
  }

  /**
   * 重新扫描技能来源，刷新 state.known。
   * 并发调用会共享同一个 Promise；失败不会抛给调用方。
   * @returns {Promise<boolean>} 是否成功完成一次扫描。
   */
  function refreshInventory() {
    if (inventoryPending !== null) return inventoryPending
    if (!ctx || !ctx.skills || typeof ctx.skills.snapshot !== 'function') {
      inventoryRetryAt = Date.now() + WORKSPACE_CACHE_MS
      return Promise.resolve(false)
    }
    inventoryPending = (async () => {
      try {
        const collected = await collectInventorySources()

        // 1) 从旧缓存出发：任何来源失败 / 不完整都不会删除旧条目。
        const merged = { ...state.known, ...collected.entries }

        // 2) disabled / bindings 引用的名字必须始终可显示；路径已不存在的移除。
        const pinned = new Set([...state.disabled, ...Object.keys(state.bindings)])
        for (const skillName of pinned) {
          const existing = merged[skillName] ?? state.known[skillName]
          if (!existing) continue
          if (typeof existing.path === 'string' && existing.path.length > 0 && !pathExists(existing.path)) {
            delete merged[skillName]
            continue
          }
          merged[skillName] = existing
        }

        // 3) 仅当所有来源都完整成功时，才剪掉已不存在的条目（含其标签 / 更新记录）。
        let tagsPruned = false
        let updatesPruned = false
        if (collected.allComplete) {
          for (const skillName of Object.keys(merged)) {
            if (pinned.has(skillName)) continue
            if (Object.hasOwn(collected.entries, skillName)) continue
            delete merged[skillName]
          }
          for (const skillName of Object.keys(state.tags)) {
            if (merged[skillName] !== undefined) continue
            delete state.tags[skillName]
            tagsPruned = true
          }
          for (const skillName of Object.keys(state.updates)) {
            if (merged[skillName] !== undefined) continue
            delete state.updates[skillName]
            updatesPruned = true
          }
        }

        // 4) 契约 v4：只为「新增 / 路径变化」的技能检测更新方式；检测结果缓存进 known，
        //    后续刷新直接复用（不重复扫盘），所以 GET 永远不需要执行命令或读脚本。
        for (const skillName of Object.keys(merged)) {
          let entry = merged[skillName]
          if (entry === null || typeof entry !== 'object') continue
          if (typeof entry.path !== 'string' || entry.path.length === 0) continue
          // 注册表快照每轮都会生成新的 summary 对象；同一路径时把上次的检测缓存继承过来。
          const cached = state.known[skillName]
          if (cached !== null && typeof cached === 'object' && cached !== entry && cached.path === entry.path && cached.updateMethod !== undefined) {
            const inherited = { ...entry }
            for (const key of UPDATE_CACHE_KEYS) {
              if (cached[key] !== undefined) inherited[key] = cached[key]
              else delete inherited[key]
            }
            entry = inherited
            merged[skillName] = entry
          }
          if (entry.updateMethod !== undefined && entry.updateDetectPath === entry.path) continue
          const detection = detectUpdateInfo(entry)
          // 拷贝再改，避免与 state.known 共享引用导致 sameKnown 无法发现变化。
          const next = { ...entry }
          next.updateMethod = detection.updateMethod
          next.canApply = detection.canApply
          next.updateDetectPath = next.path
          if (detection.version !== null) next.version = detection.version
          else delete next.version
          if (detection.repoUrl !== null) next.repoUrl = detection.repoUrl
          else delete next.repoUrl
          if (detection.scriptPath !== null) next.scriptPath = detection.scriptPath
          else delete next.scriptPath
          merged[skillName] = next
        }

        const changed = !sameKnown(state.known, merged)
        state.known = merged
        inventoryReady = true
        inventoryUpdatedAt = Date.now()
        inventoryRetryAt = 0
        if (changed || tagsPruned || updatesPruned) {
          persist()
          invalidate()
        }
        // 清单首次就绪 / 内容变化后安排 AI 标注（不阻塞、不消耗 token 直到真正执行）。
        if (tagConfig.autoTagEnabled && !tagState.running) {
          if (!tagScheduledAfterReady) {
            tagScheduledAfterReady = true
            tagState.chainBudget = tagConfig.tagMaxPerRun
            scheduleTagRun(tagConfig.tagDelayMs)
          } else if (changed) {
            tagState.chainBudget = tagConfig.tagMaxPerRun
            scheduleTagRun(tagConfig.tagIntervalMs)
          }
        }
        return true
      } catch (err) {
        log.warn(`刷新技能清单失败：${err.message}`)
        inventoryRetryAt = Date.now() + WORKSPACE_CACHE_MS
        return false
      } finally {
        inventoryPending = null
        // 扫描期间来的刷新请求合并成一次补扫，避免事件自激成循环。
        if (inventoryRefreshRequested) {
          inventoryRefreshRequested = false
          scheduleInventoryRefresh()
        }
      }
    })()
    return inventoryPending
  }

  /**
   * 防抖触发一次后台清单刷新。
   * @param {boolean} allowQueued - 扫描进行中时是否登记一次补扫（仅 Agent 生命周期变化
   *   需要，因为本轮扫描可能没覆盖到新建作用域）；skills/change 不登记，避免
   *   acquireScope 挂载/释放所产生的 change 事件把刷新变成无限循环。
   */
  function scheduleInventoryRefresh(allowQueued = false) {
    try {
      if (inventoryPending !== null) {
        if (allowQueued) inventoryRefreshRequested = true
        return
      }
      if (inventoryRefreshTimer !== null) clearTimeout(inventoryRefreshTimer)
      inventoryRefreshTimer = setTimeout(() => {
        inventoryRefreshTimer = null
        void refreshInventory()
      }, INVENTORY_DEBOUNCE_MS)
      if (typeof inventoryRefreshTimer.unref === 'function') inventoryRefreshTimer.unref()
    } catch (err) {
      log.warn(`安排技能清单刷新失败：${err.message}`)
    }
  }

  /* -------------------------- 统计（§4.4） -------------------------- */

  /**
   * 启动一次后台统计扫描；已有扫描在跑时直接复用。
   * @returns {Promise<void>} 扫描完成（或已在进行）的 Promise。
   */
  function scanStats() {
    if (scanState.scanning) return scanState.pending ?? Promise.resolve()
    scanState.scanning = true
    scanState.pending = (async () => {
      try {
        await runStatsScan()
      } catch (err) {
        log.warn(`统计扫描失败：${err.message}`)
      } finally {
        scanState.scanning = false
        scanState.pending = null
      }
    })()
    return scanState.pending
  }

  /** 读取持久化层的轻量签名表；不可用时返回 null。 */
  async function readPersistenceSignatures() {
    const persistence = service('sessionPersistence')
    if (!persistence || typeof persistence.list !== 'function') return null
    let snapshots
    try {
      snapshots = await persistence.list()
    } catch (err) {
      log.warn(`读取会话持久化清单失败：${err.message}`)
      return null
    }
    if (!Array.isArray(snapshots)) return null
    const signatures = new Map()
    for (const snapshot of snapshots) {
      if (snapshot === null || typeof snapshot !== 'object') continue
      const sessionId = snapshot.header?.id ?? snapshot.id
      if (typeof sessionId !== 'string' || sessionId.length === 0) continue
      if (typeof snapshot.eventCount === 'number' && typeof snapshot.sizeBytes === 'number') {
        signatures.set(sessionId, `${snapshot.eventCount}:${snapshot.sizeBytes}`)
        continue
      }
      // 后端不提供 eventCount/sizeBytes 时，退化为它的 revision 变更令牌。
      if (typeof snapshot.revision === 'string' && snapshot.revision.length > 0) {
        signatures.set(sessionId, `rev:${snapshot.revision}`)
      }
    }
    return signatures
  }

  /** 从一次工具调用参数里取出技能名。 */
  function skillNameFromArguments(rawArguments) {
    if (typeof rawArguments !== 'string' || rawArguments.length === 0) return undefined
    try {
      const parsed = JSON.parse(rawArguments)
      if (parsed === null || typeof parsed !== 'object') return undefined
      return isSkillName(parsed.name) ? parsed.name : undefined
    } catch {
      return undefined
    }
  }

  /** 读取一个会话的完整日志，累计技能调用次数。 */
  async function scanOneSession(sessionQuery, item) {
    const snapshot = await sessionQuery.readSession(item.sessionId)
    const events = Array.isArray(snapshot?.events) ? snapshot.events : []
    const skills = {}
    let lastUsedAt = 0

    for (const event of events) {
      if (event === null || typeof event !== 'object') continue
      const at = toNonNegativeInt(event.time)
      if (event.type === 'tool/call') {
        const data = event.data
        if (!data || data.name !== 'skill') continue
        const skillName = skillNameFromArguments(data.arguments)
        if (skillName === undefined) continue
        skills[skillName] = (skills[skillName] ?? 0) + 1
        if (at > lastUsedAt) lastUsedAt = at
        continue
      }
      if (event.type === 'user/message') {
        const data = event.data
        if (data === null || typeof data !== 'object') continue
        // 契约里写的是 data.message.source；真实日志是 data.source，两者都兼容。
        const source = data.source ?? data.message?.source
        if (!source || typeof source !== 'object' || source.kind !== 'skill-invocation') continue
        const skillName = source.name
        if (!isSkillName(skillName)) continue
        skills[skillName] = (skills[skillName] ?? 0) + 1
        if (at > lastUsedAt) lastUsedAt = at
      }
    }

    state.stats.sessions[item.sessionId] = { sig: item.sig, lastUsedAt, skills }
  }

  /** 实际执行一次统计扫描（单例，调用方保证 scanState.scanning）。 */
  async function runStatsScan() {
    const sessionQuery = service('sessionQuery')
    if (!sessionQuery || typeof sessionQuery.listSessions !== 'function') return

    let records
    try {
      records = await sessionQuery.listSessions()
    } catch (err) {
      log.warn(`列出会话失败：${err.message}`)
      return
    }
    if (!Array.isArray(records)) return

    const limited = records.slice(0, MAX_SCAN_SESSIONS)
    scanState.totalSessions = limited.length

    const signatures = await readPersistenceSignatures()
    // 拿不到持久化签名时无法可靠判断「未变化」，退化为每次全量重扫。
    const deltaAvailable = signatures !== null

    const pending = []
    for (const record of limited) {
      if (record === null || typeof record !== 'object') continue
      const header = record.header
      const sessionId = header?.id
      if (!isSessionId(sessionId)) continue
      const previous = state.stats.sessions[sessionId]
      const signature = signatures?.get(sessionId)
        ?? `created:${toNonNegativeInt(header?.createdAt)}`
      // 活跃会话随时在增长，永远重读；其余按签名做增量。
      const live = record.live === true
      if (deltaAvailable && !live && previous !== undefined && previous.sig === signature) continue
      pending.push({ sessionId, sig: signature })
    }

    let cursor = 0
    let processed = 0
    const worker = async () => {
      while (cursor < pending.length) {
        const item = pending[cursor]
        cursor += 1
        try {
          await scanOneSession(sessionQuery, item)
        } catch (err) {
          log.warn(`读取会话 ${item.sessionId} 失败：${err.message}`)
        }
        processed += 1
        if (processed % 10 === 0) persist()
      }
    }
    const workerCount = Math.max(1, Math.min(SCAN_CONCURRENCY, pending.length))
    await Promise.all(Array.from({ length: workerCount }, () => worker()))

    state.stats.updatedAt = Date.now()
    persist()
  }

  /* ------------------------ AI 标签（契约 v3 §3） ------------------------ */

  /** apply(config) 的标签配置：默认值 + 范围夹取，非法值一律回退默认。 */
  function resolveTagConfig(rawConfig) {
    const raw = rawConfig !== null && typeof rawConfig === 'object' && !Array.isArray(rawConfig) ? rawConfig : {}
    return {
      autoTagEnabled: typeof raw.autoTagEnabled === 'boolean' ? raw.autoTagEnabled : TAG_CONFIG_DEFAULTS.autoTagEnabled,
      tagBatchSize: clampInt(raw.tagBatchSize, TAG_CONFIG_DEFAULTS.tagBatchSize, 1, 12),
      tagMaxPerRun: clampInt(raw.tagMaxPerRun, TAG_CONFIG_DEFAULTS.tagMaxPerRun, 1, 64),
      tagDelayMs: clampInt(raw.tagDelayMs, TAG_CONFIG_DEFAULTS.tagDelayMs, 0, 3_600_000),
      tagIntervalMs: clampInt(raw.tagIntervalMs, TAG_CONFIG_DEFAULTS.tagIntervalMs, 1_000, 3_600_000),
      tagBackoffMs: clampInt(raw.tagBackoffMs, TAG_CONFIG_DEFAULTS.tagBackoffMs, 1_000, 86_400_000),
    }
  }

  const tagConfig = resolveTagConfig(config)
  /** 标签任务运行时状态（lastRunAt / lastError 只存在内存，不落盘）。 */
  const tagState = { running: false, lastRunAt: 0, lastError: null, chainBudget: tagConfig.tagMaxPerRun }
  // 客户端半边自报的诊断（注册失败等），仅内存态、不落盘，用于排查 slot 注册异常。
  const clientReport = { message: null, at: 0 }
  /** 插件生命周期（卸载时 abort 进行中的模型请求）。 */
  const tagLifecycle = new AbortController()
  let tagTimer = null
  let tagNextAttemptAt = 0
  let tagScheduledAfterReady = false

  /** 读取一条标签记录（不存在时返回空结构）。 */
  function tagEntryFor(skillName) {
    const entry = state.tags[skillName]
    if (entry === null || typeof entry !== 'object') return { ai: [], user: [], muted: [], aiAt: 0 }
    return {
      ai: Array.isArray(entry.ai) ? entry.ai.filter((tag) => typeof tag === 'string') : [],
      user: Array.isArray(entry.user) ? entry.user.filter((tag) => typeof tag === 'string') : [],
      muted: Array.isArray(entry.muted) ? entry.muted.filter((tag) => typeof tag === 'string') : [],
      aiAt: toNonNegativeInt(entry.aiAt),
    }
  }

  /** 技能的 description（未知/非法为空串）。 */
  function knownDescription(skillName) {
    const entry = state.known[skillName]
    return entry && typeof entry.description === 'string' ? entry.description : ''
  }

  /**
   * 待 AI 标注的技能：description 非空且从未标注（aiAt === 0）。
   * 契约要求「已标注过的技能永不重标」，因此 aiAt > 0 一律排除。
   * @returns {string[]} 按 name 升序的技能名。
   */
  function taggingEligible() {
    const names = []
    for (const skillName of Object.keys(state.known)) {
      if (!isSkillName(skillName)) continue
      if (knownDescription(skillName).trim().length === 0) continue
      if (tagEntryFor(skillName).aiAt > 0) continue
      names.push(skillName)
    }
    names.sort()
    return names
  }

  /** 已带 AI 标签的技能数量（payload tagging.tagged）。 */
  function taggedSkillCount() {
    let count = 0
    for (const skillName of Object.keys(state.known)) {
      if (tagEntryFor(skillName).ai.length > 0) count += 1
    }
    return count
  }

  /** 技能展示标签：user 优先，其后是未被 muted / 未被 user 同名覆盖的 ai 标签。 */
  function displayTagsFor(skillName) {
    const entry = tagEntryFor(skillName)
    const muted = new Set(entry.muted.map(tagKey))
    const userKeys = new Set(entry.user.map(tagKey))
    const tags = entry.user.map((text) => ({ text, source: 'user' }))
    for (const text of entry.ai) {
      const key = tagKey(text)
      if (muted.has(key) || userKeys.has(key)) continue
      tags.push({ text, source: 'ai' })
    }
    return tags
  }

  /**
   * 汇总全部展示标签的计数（count 降序，相同 count 按 text 升序）。
   * @param {Array<Array<{text: string}>>} perSkillTags - 每个技能的展示标签。
   * @returns {{ text: string, count: number }[]}
   */
  function buildTagCounts(perSkillTags) {
    const counts = new Map()
    for (const tags of perSkillTags) {
      for (const tag of tags) counts.set(tag.text, (counts.get(tag.text) ?? 0) + 1)
    }
    return [...counts.entries()]
      .map(([text, count]) => ({ text, count }))
      .sort((left, right) => (right.count - left.count) || (left.text < right.text ? -1 : left.text > right.text ? 1 : 0))
  }

  /**
   * 解析当前默认模型路由。任何环节缺失都返回 undefined（调用方降级为 enabled=false + no-model）。
   * @returns {{ provider: string, model: string }|undefined}
   */
  function resolveTagRoute() {
    try {
      const llm = service('llm')
      if (!llm || typeof llm.stream !== 'function') return undefined
      const defaultModel = service('agentDefaultModel')
      if (!defaultModel || typeof defaultModel.currentSelection !== 'function') return undefined
      const selection = defaultModel.currentSelection()
      if (selection === null || typeof selection !== 'object') return undefined
      const provider = selection.provider
      const model = selection.model
      if (typeof provider !== 'string' || provider.length === 0) return undefined
      if (typeof model !== 'string' || model.length === 0) return undefined
      if (typeof llm.listProviders === 'function') {
        const providers = llm.listProviders()
        if (Array.isArray(providers) && providers.length > 0) {
          // LlmProviderInfo.id 才是 GenerateOptions.provider 的 route key。
          if (!providers.some((info) => info && info.id === provider)) return undefined
        }
      }
      return { provider, model }
    } catch (err) {
      log.warn(`解析 AI 标注模型失败：${err.message}`)
      return undefined
    }
  }

  /** 是否存在非 idle 的 live Agent（运行中不做自动标注，避免抢 token/上下文）。 */
  function agentsBusy() {
    try {
      const agents = service('agents')
      const list = agents && typeof agents.list === 'function' ? agents.list() : []
      return (Array.isArray(list) ? list : []).some((agent) => agent !== null && typeof agent === 'object' && agent.status !== 'idle')
    } catch {
      return false
    }
  }

  /** 清掉唯一的标签定时器。 */
  function clearTagTimer() {
    if (tagTimer !== null) {
      clearTimeout(tagTimer)
      tagTimer = null
    }
  }

  /** 安排一次自动标注（防抖：只保留一个定时器；插件卸载后不再安排）。 */
  function scheduleTagRun(delayMs) {
    try {
      if (tagLifecycle.signal.aborted) return
      clearTagTimer()
      const delay = Math.max(0, clampInt(delayMs, tagConfig.tagDelayMs, 0, 3_600_000))
      tagTimer = setTimeout(() => {
        tagTimer = null
        void runTagBatch(false)
      }, delay)
      if (typeof tagTimer.unref === 'function') tagTimer.unref()
    } catch (err) {
      log.warn(`安排 AI 标注任务失败：${err.message}`)
    }
  }

  /**
   * 发起一次标注模型调用（一次请求覆盖整批技能），返回拼接后的文本。
   * @param {{provider: string, model: string}} route - 默认模型路由。
   * @param {string[]} batch - 本批技能名。
   * @returns {Promise<string>} 模型输出的完整文本。
   */
  async function requestTagCompletion(route, batch) {
    const llm = service('llm')
    if (!llm || typeof llm.stream !== 'function') throw new Error('no-model')
    const items = batch.map((skillName) => ({
      n: skillName,
      d: knownDescription(skillName).slice(0, TAG_DESCRIPTION_LIMIT),
    }))
    const prompt = '为下列每个技能给出 1-2 个简短中文标签（2-6 个字的名词短语，不要标点、不要“工具/技能/其他”这类泛词）。'
      + '只输出 JSON 对象，键为技能名：{"<name>":["标签1","标签2"]}。\n技能列表：\n'
      + JSON.stringify(items)
    let signal = tagLifecycle.signal
    if (typeof AbortSignal === 'function' && typeof AbortSignal.any === 'function' && typeof AbortSignal.timeout === 'function') {
      signal = AbortSignal.any([tagLifecycle.signal, AbortSignal.timeout(TAG_REQUEST_TIMEOUT_MS)])
    }
    const options = {
      provider: route.provider,
      model: route.model,
      system: TAG_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      maxTokens: 300,
      temperature: 0,
      purpose: 'skill-tagging',
      signal,
    }
    let text = ''
    for await (const chunk of llm.stream(options)) {
      if (tagLifecycle.signal.aborted) throw new Error('aborted')
      if (chunk !== null && typeof chunk === 'object' && chunk.type === 'text-delta' && typeof chunk.text === 'string') {
        text += chunk.text
      }
    }
    return text
  }

  /**
   * 解析模型输出：取第一个 `{` 到最后一个 `}`，JSON.parse；未知键/非法形状忽略。
   * @param {string} rawText - 模型输出文本。
   * @returns {Map<string, string[]>|undefined} 合法结果；失败返回 undefined。
   */
  function parseTagResponse(rawText) {
    const text = typeof rawText === 'string' ? rawText : ''
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start === -1 || end === -1 || end <= start) return undefined
    let parsed
    try {
      parsed = JSON.parse(text.slice(start, end + 1))
    } catch {
      return undefined
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    const result = new Map()
    for (const [skillName, value] of Object.entries(parsed)) {
      if (!isSkillName(skillName) || state.known[skillName] === undefined) continue
      const tags = sanitizeTagList(value, MAX_AI_TAGS_PER_SKILL)
      if (tags === undefined || tags.length === 0) continue
      result.set(skillName, tags)
    }
    return result
  }

  /**
   * 执行一批 AI 标注（单飞）。失败只记录 lastError + 退避，绝不抛出。
   * @param {boolean} force - tagNow 触发：忽略 idle/退避限制。
   * @returns {Promise<boolean>} 是否完成了一次成功的标注调用。
   */
  async function runTagBatch(force) {
    if (tagState.running) return false
    if (!force && !tagConfig.autoTagEnabled) return false
    tagState.running = true
    try {
      // 契约：清单 ready 之前不跑。
      if (!inventoryReady) return false
      if (!force) {
        // 清单扫描 / 统计扫描 / 任意 Agent 运行中：推迟 30s，避免抢 token。
        if (inventoryPending !== null || scanState.scanning || agentsBusy()) {
          scheduleTagRun(TAG_BUSY_RETRY_MS)
          return false
        }
        const wait = tagNextAttemptAt - Date.now()
        if (wait > 0) {
          scheduleTagRun(wait)
          return false
        }
      }
      const route = resolveTagRoute()
      if (route === undefined) {
        tagState.lastError = 'no-model'
        if (tagConfig.autoTagEnabled) scheduleTagRun(tagConfig.tagBackoffMs)
        return false
      }
      const eligible = taggingEligible()
      if (eligible.length === 0) {
        clearTagTimer()
        return true
      }
      const budget = force ? tagConfig.tagMaxPerRun : tagState.chainBudget
      if (budget <= 0) {
        clearTagTimer()
        return false
      }
      const batch = eligible.slice(0, Math.min(tagConfig.tagBatchSize, budget))

      let completion
      try {
        completion = await requestTagCompletion(route, batch)
      } catch (err) {
        tagState.lastError = truncateText(err && err.message !== undefined ? err.message : err, TAG_ERROR_LIMIT)
        tagNextAttemptAt = Date.now() + tagConfig.tagBackoffMs
        if (tagConfig.autoTagEnabled) scheduleTagRun(tagConfig.tagBackoffMs)
        return false
      }

      const parsed = parseTagResponse(completion)
      if (parsed === undefined || parsed.size === 0) {
        tagState.lastError = 'invalid-response'
        tagNextAttemptAt = Date.now() + tagConfig.tagBackoffMs
        if (tagConfig.autoTagEnabled) scheduleTagRun(tagConfig.tagBackoffMs)
        return false
      }

      const now = Date.now()
      for (const [skillName, tags] of parsed) {
        if (state.known[skillName] === undefined) continue
        const existing = tagEntryFor(skillName)
        state.tags[skillName] = { ai: tags, user: existing.user, muted: existing.muted, aiAt: now }
      }
      tagState.lastRunAt = now
      tagState.lastError = null
      tagNextAttemptAt = 0
      persist()

      if (force) tagState.chainBudget = tagConfig.tagMaxPerRun
      tagState.chainBudget = Math.max(0, tagState.chainBudget - batch.length)
      const remaining = taggingEligible()
      // 还有待标注技能时继续：预算内按 tagIntervalMs 连跑；预算用完则延后续一轮，
      // 既保证最终覆盖全部技能，又避免一次消耗过多 token。
      if (tagConfig.autoTagEnabled && remaining.length > 0) {
        if (tagState.chainBudget > 0) {
          scheduleTagRun(tagConfig.tagIntervalMs)
        } else {
          tagState.chainBudget = tagConfig.tagMaxPerRun
          scheduleTagRun(TAG_CONTINUE_DELAY_MS)
        }
      } else clearTagTimer()
      return true
    } catch (err) {
      // 兜底：任何未预期异常都只记 lastError + 退避。
      tagState.lastError = truncateText(err && err.message !== undefined ? err.message : err, TAG_ERROR_LIMIT)
      tagNextAttemptAt = Date.now() + tagConfig.tagBackoffMs
      if (tagConfig.autoTagEnabled) scheduleTagRun(tagConfig.tagBackoffMs)
      return false
    } finally {
      tagState.running = false
    }
  }

  /** tagNow：立刻强制跑一轮（忽略 idle/退避），不等待结果。 */
  function kickTagNow() {
    tagState.chainBudget = tagConfig.tagMaxPerRun
    tagNextAttemptAt = 0
    clearTagTimer()
    void runTagBatch(true)
  }

  /** payload.tagging（纯内存计算，GET 期间也 <1ms）。 */
  function tagPayload() {
    const route = resolveTagRoute()
    const enabled = tagConfig.autoTagEnabled && route !== undefined
    return {
      enabled,
      running: tagState.running,
      queued: taggingEligible().length,
      lastRunAt: toNonNegativeInt(tagState.lastRunAt),
      lastError: route === undefined && tagConfig.autoTagEnabled ? 'no-model' : tagState.lastError,
      tagged: taggedSkillCount(),
      model: route === undefined ? null : `${route.provider}/${route.model}`,
    }
  }

  /* ------------------- 更新检测结果 / 更新执行（契约 v4） ------------------- */

  /** 命令执行器：默认 spawnSync；测试可通过 apply(config.commandRunner) 注入假实现。 */
  const spawnCommand = config !== null && typeof config === 'object' && typeof config.commandRunner === 'function'
    ? config.commandRunner
    : spawnSync
  /** 单技能更新命令的单飞表（name → Promise）。 */
  const updateInFlight = new Map()
  /** 每个技能选中的 Python 解释器（避免每次重试 python3 → python）。 */
  const pythonInterpreterCache = new Map()

  /** 统一 spawn 结果形状（超时/ENOENT 也能安全判定）。 */
  function normalizeCommandResult(result) {
    const normalized = { status: null, stdout: '', stderr: '', timedOut: false, errorCode: undefined }
    if (result === null || typeof result !== 'object') return normalized
    if (typeof result.status === 'number') normalized.status = result.status
    if (typeof result.stdout === 'string') normalized.stdout = result.stdout
    if (typeof result.stderr === 'string') normalized.stderr = result.stderr
    if (result.error !== null && typeof result.error === 'object' && typeof result.error.code === 'string') {
      normalized.errorCode = result.error.code
      if (result.error.code === 'ETIMEDOUT') normalized.timedOut = true
    }
    if (result.signal === 'SIGTERM' || result.signal === 'SIGKILL') normalized.timedOut = true
    return normalized
  }

  /**
   * 执行一条命令（永不使用 shell）。
   * @param {string} file - 可执行文件。
   * @param {string[]} args - 参数（外部只允许追加固定的 --update）。
   * @param {{ cwd?: string, timeout?: number }} options - cwd / 超时。
   * @returns {{ status: number|null, stdout: string, stderr: string, timedOut: boolean, errorCode?: string }}
   */
  function runCommand(file, args, options = {}) {
    const commandOptions = {
      cwd: typeof options.cwd === 'string' ? options.cwd : undefined,
      timeout: Number.isFinite(options.timeout) ? options.timeout : SCRIPT_UPDATE_TIMEOUT_MS,
      windowsHide: true,
      encoding: 'utf8',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' },
    }
    try {
      return normalizeCommandResult(spawnCommand(file, args, commandOptions))
    } catch (err) {
      return normalizeCommandResult({ error: { code: err && typeof err.code === 'string' ? err.code : 'SPAWN-FAILED' }, stderr: String(err && err.message ? err.message : err) })
    }
  }

  /** stderr 尾部（≤300 字）。 */
  function stderrTail(text) {
    const value = typeof text === 'string' ? text.trim() : ''
    if (value.length === 0) return ''
    return value.length > MAX_UPDATE_MESSAGE ? value.slice(-MAX_UPDATE_MESSAGE) : value
  }

  /** stdout 的第一条非空行（≤300 字）。 */
  function firstNonEmptyLine(text) {
    if (typeof text !== 'string') return ''
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (trimmed.length > 0) return truncateText(trimmed, MAX_UPDATE_MESSAGE)
    }
    return ''
  }

  /** 写一条更新记录并落盘。 */
  function storeUpdateRecord(name, patch) {
    const record = {
      state: patch && UPDATE_STATES.has(patch.state) ? patch.state : 'unknown',
      latest: patch && typeof patch.latest === 'string' && patch.latest.length > 0 ? patch.latest.slice(0, 100) : null,
      message: patch && typeof patch.message === 'string' && patch.message.length > 0 ? truncateText(patch.message, MAX_UPDATE_MESSAGE) : null,
      checkedAt: Date.now(),
    }
    state.updates[name] = record
    persist()
  }

  /** 让某技能的检测缓存失效（更新成功后需要重新读版本号）。 */
  function invalidateUpdateDetection(name) {
    const entry = state.known[name]
    if (entry === null || typeof entry !== 'object') return
    delete entry.updateMethod
    delete entry.canApply
    delete entry.version
    delete entry.repoUrl
    delete entry.scriptPath
    delete entry.updateDetectPath
  }

  /** 确保某技能已有检测缓存（缺失时同步检测一次并落盘）。 */
  function ensureUpdateDetection(name) {
    const entry = state.known[name]
    if (entry === null || typeof entry !== 'object') return
    if (typeof entry.path !== 'string' || entry.path.length === 0) return
    if (entry.updateMethod !== undefined && entry.updateDetectPath === entry.path) return
    const detection = detectUpdateInfo(entry)
    entry.updateMethod = detection.updateMethod
    entry.canApply = detection.canApply
    entry.updateDetectPath = entry.path
    if (detection.version !== null) entry.version = detection.version
    else delete entry.version
    if (detection.repoUrl !== null) entry.repoUrl = detection.repoUrl
    else delete entry.repoUrl
    if (detection.scriptPath !== null) entry.scriptPath = detection.scriptPath
    else delete entry.scriptPath
    persist()
  }

  /** payload.skills[].update：持久记录 + 实时 busy + 检测默认值。 */
  function updateViewFor(name) {
    const entry = state.known[name]
    const method = entry && UPDATE_METHODS.has(entry.updateMethod) ? entry.updateMethod : 'none'
    const canApply = Boolean(entry && entry.canApply === true)
    const record = state.updates[name]
    let viewState = 'unknown'
    let latest = null
    let message = null
    let checkedAt = 0
    if (record !== null && typeof record === 'object' && UPDATE_STATES.has(record.state)) {
      viewState = record.state
      latest = typeof record.latest === 'string' ? record.latest : null
      message = typeof record.message === 'string' ? record.message : null
      checkedAt = toNonNegativeInt(record.checkedAt)
    } else if (method === 'bundled') {
      viewState = 'not-applicable'
      message = '内置技能随 DSH / 插件更新'
    } else if (method === 'none') {
      viewState = 'not-applicable'
      message = entry !== undefined && typeof entry.scriptPath === 'string' ? '仅支持 Python 更新脚本' : '无关联代码仓'
    } else if (method === 'git-project') {
      message = '属于上级项目仓库，请随项目更新'
    }
    return {
      method,
      state: viewState,
      latest,
      message,
      checkedAt,
      canApply,
      busy: updateInFlight.has(name),
    }
  }

  /** 用选中的解释器跑 Python 脚本（python3 → python 回退，按技能缓存选择）。 */
  function runPythonScript(name, scriptPath, dir, args) {
    const cached = pythonInterpreterCache.get(name)
    const interpreters = cached === undefined ? PYTHON_INTERPRETERS : [cached]
    let last = normalizeCommandResult(undefined)
    for (const interpreter of interpreters) {
      const result = runCommand(interpreter, [scriptPath, ...args], { cwd: dir, timeout: SCRIPT_UPDATE_TIMEOUT_MS })
      last = result
      if (result.errorCode === 'ENOENT') continue
      pythonInterpreterCache.set(name, interpreter)
      return result
    }
    return last
  }

  /**
   * Oil 系列技能（check_update.py）会把最近一次成功联网的版本写进
   * LOCALAPPDATA/oil/<name>-update.json（非 win32 用 XDG_STATE_HOME/~/.local/state）。
   * 仅当脚本本身就是 check_update.py 时读取，作为「脚本静默时」的补充信息。
   * @returns {{latest: string, checkedAt: number, failedAt: number} | undefined}
   */
  function readOilScriptCache(name) {
    try {
      const base = process.platform === 'win32'
        ? (process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'))
        : (process.env.XDG_STATE_HOME ?? path.join(os.homedir(), '.local', 'state'))
      const file = path.join(base, 'oil', `${name}-update.json`)
      if (!pathExists(file)) return undefined
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
      const latest = typeof raw.latest === 'string' ? raw.latest : null
      const checkedAt = typeof raw.checked_at === 'number' ? raw.checked_at * 1000 : 0
      const failedAt = typeof raw.fetch_failed_at === 'number' ? raw.fetch_failed_at * 1000 : 0
      if (latest === null) return undefined
      return { latest, checkedAt, failedAt }
    } catch {
      return undefined
    }
  }

  /** 更新脚本方式：check / apply。 */
  async function runScriptUpdate(name, entry, apply) {
    const file = entry.path
    if (typeof file !== 'string' || file.length === 0) {
      storeUpdateRecord(name, { state: 'failed', message: '未找到技能目录' })
      return
    }
    const dir = path.dirname(file)
    let scriptPath = typeof entry.scriptPath === 'string' && pathExists(entry.scriptPath) ? entry.scriptPath : undefined
    if (scriptPath === undefined) {
      const found = findUpdateScript(dir)
      scriptPath = found === undefined ? undefined : found.scriptPath
    }
    if (scriptPath === undefined || !pathExists(scriptPath)) {
      storeUpdateRecord(name, { state: 'failed', message: '未找到更新脚本' })
      return
    }
    const currentVersion = typeof entry.version === 'string' ? entry.version : null
    const check = runPythonScript(name, scriptPath, dir, [])
    if (check.timedOut) {
      storeUpdateRecord(name, { state: 'failed', message: '检查超时' })
      return
    }
    if (check.errorCode === 'ENOENT') {
      storeUpdateRecord(name, { state: 'failed', message: '未找到 Python 解释器' })
      return
    }
    if (check.status !== 0) {
      storeUpdateRecord(name, { state: 'failed', message: stderrTail(check.stderr) || `更新脚本退出码 ${check.status ?? '?'}` })
      return
    }
    const stdout = check.stdout.trim()
    let latest = null
    let availableReason = null
    if (stdout.length === 0) {
      // 脚本约定：无输出 = 没有新版本 / 网络失败 / 开发目录里运行。
      // Oil 类脚本会把最近一次成功联网的版本缓存在本地，可据此补一条「可更新」提示。
      const cached = path.basename(scriptPath) === 'check_update.py' ? readOilScriptCache(name) : undefined
      if (cached !== undefined) {
        const currentTriple = currentVersion === null ? null : parseVersionTriple(currentVersion)
        const cachedTriple = parseVersionTriple(cached.latest)
        const when = cached.checkedAt > 0 ? new Date(cached.checkedAt).toISOString().slice(0, 10) : '未知日期'
        if (currentTriple !== null && cachedTriple !== null && compareVersionTriples(cachedTriple, currentTriple) > 0) {
          latest = cached.latest
          availableReason = `上游版本 ${cached.latest}（脚本缓存于 ${when}）`
        } else if (currentTriple !== null) {
          storeUpdateRecord(name, { state: 'up-to-date', latest: currentVersion, message: `已是最新（缓存 ${cached.latest}，${when}）` })
          return
        }
      }
      if (latest === null) {
        storeUpdateRecord(name, { state: 'unknown', message: '脚本未报告更新（可能已是最新或暂时无法联网）' })
        return
      }
    } else {
      latest = parseLatestVersion(stdout, currentVersion)
      availableReason = firstNonEmptyLine(stdout)
    }
    storeUpdateRecord(name, { state: 'available', latest, message: availableReason })
    if (!apply) return
    if (entry.canApply !== true) {
      storeUpdateRecord(name, { state: 'not-applicable', latest, message: '更新脚本不支持 --update' })
      return
    }
    // 固定参数 + 仅追加 --update（不经过 shell）。
    const update = runPythonScript(name, scriptPath, dir, ['--update'])
    if (update.timedOut) {
      storeUpdateRecord(name, { state: 'failed', latest, message: '更新超时' })
      return
    }
    if (update.status !== 0) {
      storeUpdateRecord(name, { state: 'failed', latest, message: stderrTail(update.stderr) || `更新脚本退出码 ${update.status ?? '?'}` })
      return
    }
    const marked = /已自动更新|updated/i.test(update.stdout)
    invalidateUpdateDetection(name)
    await refreshInventory()
    const fresh = state.known[name]
    const freshVersion = fresh && typeof fresh.version === 'string' ? fresh.version : null
    const versionChanged = freshVersion !== null && freshVersion !== currentVersion
    if (marked || versionChanged) {
      storeUpdateRecord(name, { state: 'updated', latest: freshVersion ?? latest, message: firstNonEmptyLine(update.stdout) || '已更新' })
    } else {
      storeUpdateRecord(name, { state: 'failed', latest, message: '更新脚本未报告成功' })
    }
  }

  /** 执行 git 命令（cwd 固定为仓库根，参数不含用户输入）。 */
  function runGit(repoRoot, args, timeout) {
    return runCommand('git', ['-C', repoRoot, ...args], { cwd: repoRoot, timeout })
  }

  /** git / git-project：fetch + 落后提交数；仅 method=git 且干净仓库允许 pull。 */
  async function runGitUpdate(name, entry, apply, method) {
    const file = entry.path
    if (typeof file !== 'string' || file.length === 0) {
      storeUpdateRecord(name, { state: 'failed', message: '未找到技能目录' })
      return
    }
    const repo = findGitRepo(path.dirname(file))
    if (repo === undefined) {
      storeUpdateRecord(name, { state: 'failed', message: '未找到 git 仓库' })
      return
    }
    const repoRoot = repo.repoRoot
    const currentVersion = typeof entry.version === 'string' ? entry.version : null
    const fetch = runGit(repoRoot, ['fetch', '--quiet'], GIT_FETCH_TIMEOUT_MS)
    if (fetch.timedOut) {
      storeUpdateRecord(name, { state: 'failed', message: '检查超时' })
      return
    }
    if (fetch.errorCode === 'ENOENT') {
      storeUpdateRecord(name, { state: 'failed', message: '未找到 git 命令' })
      return
    }
    if (fetch.status !== 0) {
      storeUpdateRecord(name, { state: 'failed', message: stderrTail(fetch.stderr) || 'git fetch 失败' })
      return
    }
    let upstream = ''
    const upstreamResult = runGit(repoRoot, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], GIT_FETCH_TIMEOUT_MS)
    if (upstreamResult.status === 0) upstream = upstreamResult.stdout.trim()
    let behind = null
    let latest = null
    if (upstream.length > 0) {
      const countResult = runGit(repoRoot, ['rev-list', '--count', `HEAD..${upstream}`], GIT_FETCH_TIMEOUT_MS)
      if (countResult.status === 0) {
        const parsed = Number.parseInt(countResult.stdout.trim(), 10)
        if (Number.isFinite(parsed) && parsed >= 0) behind = parsed
      }
      if (behind !== null && behind > 0) {
        const shaResult = runGit(repoRoot, ['rev-parse', '--short', upstream], GIT_FETCH_TIMEOUT_MS)
        if (shaResult.status === 0 && shaResult.stdout.trim().length > 0) latest = shaResult.stdout.trim()
      }
    }
    // 没有 upstream 时退化为 ls-remote origin HEAD 与本地 HEAD 比较（-1 = 有更新但计数未知）。
    if (behind === null) {
      const remoteHead = runGit(repoRoot, ['ls-remote', 'origin', 'HEAD'], GIT_FETCH_TIMEOUT_MS)
      const localHead = runGit(repoRoot, ['rev-parse', 'HEAD'], GIT_FETCH_TIMEOUT_MS)
      if (remoteHead.status === 0 && localHead.status === 0) {
        const remoteSha = (remoteHead.stdout.trim().split(/\s+/)[0] ?? '')
        const localSha = localHead.stdout.trim()
        if (remoteSha.length > 0 && localSha.length > 0) {
          if (remoteSha === localSha) behind = 0
          else {
            behind = -1
            latest = remoteSha.slice(0, 7)
          }
        }
      }
    }
    if (behind === null) {
      storeUpdateRecord(name, { state: 'failed', message: '无法确定上游分支' })
      return
    }
    if (behind === 0) {
      storeUpdateRecord(name, { state: 'up-to-date', latest: currentVersion, message: '已是最新' })
      return
    }
    storeUpdateRecord(name, {
      state: 'available',
      latest,
      message: behind > 0 ? `落后 ${behind} 个提交` : '落后远程更新',
    })
    if (!apply) return
    if (method === 'git-project' || entry.canApply !== true) {
      storeUpdateRecord(name, { state: 'not-applicable', latest, message: '属于上级项目仓库，请随项目更新' })
      return
    }
    const statusResult = runGit(repoRoot, ['status', '--porcelain'], GIT_FETCH_TIMEOUT_MS)
    if (statusResult.status !== 0) {
      storeUpdateRecord(name, { state: 'failed', latest, message: 'git status 失败' })
      return
    }
    if (statusResult.stdout.trim().length > 0) {
      storeUpdateRecord(name, { state: 'failed', latest, message: '仓库有未提交的改动，已停止更新' })
      return
    }
    const pull = runGit(repoRoot, ['pull', '--ff-only'], GIT_PULL_TIMEOUT_MS)
    if (pull.timedOut) {
      storeUpdateRecord(name, { state: 'failed', latest, message: '更新超时' })
      return
    }
    if (pull.status !== 0) {
      storeUpdateRecord(name, { state: 'failed', latest, message: stderrTail(pull.stderr) || 'git pull --ff-only 失败' })
      return
    }
    invalidateUpdateDetection(name)
    await refreshInventory()
    const fresh = state.known[name]
    const freshVersion = fresh && typeof fresh.version === 'string' ? fresh.version : null
    storeUpdateRecord(name, { state: 'updated', latest: freshVersion ?? currentVersion, message: '已更新到最新' })
  }

  /** metadata：ls-remote 标签比对；无更新方式，apply 直接 not-applicable。 */
  async function runMetadataUpdate(name, entry, apply) {
    if (apply) {
      storeUpdateRecord(name, { state: 'not-applicable', message: '未检测到更新方式，请在代码仓手动更新' })
      return
    }
    const repoUrl = typeof entry.repoUrl === 'string' && entry.repoUrl.length > 0 ? entry.repoUrl : null
    if (repoUrl === null) {
      storeUpdateRecord(name, { state: 'failed', message: '未配置代码仓地址' })
      return
    }
    const currentVersion = typeof entry.version === 'string' ? entry.version : null
    const result = runCommand('git', ['ls-remote', '--tags', '--refs', repoUrl], { timeout: LS_REMOTE_TIMEOUT_MS })
    if (result.timedOut) {
      storeUpdateRecord(name, { state: 'failed', message: '检查超时' })
      return
    }
    if (result.errorCode === 'ENOENT') {
      storeUpdateRecord(name, { state: 'failed', message: '未找到 git 命令' })
      return
    }
    if (result.status !== 0) {
      storeUpdateRecord(name, { state: 'failed', message: stderrTail(result.stderr) || 'git ls-remote 失败' })
      return
    }
    const best = highestTagVersion(result.stdout)
    if (best === null) {
      if (currentVersion === null) storeUpdateRecord(name, { state: 'unknown', message: '未找到版本标签' })
      else storeUpdateRecord(name, { state: 'up-to-date', latest: currentVersion, message: '未找到版本标签' })
      return
    }
    const bestTriple = parseVersionTriple(best)
    const currentTriple = currentVersion === null ? null : parseVersionTriple(currentVersion)
    if (bestTriple === null || (currentTriple !== null && compareVersionTriples(bestTriple, currentTriple) <= 0)) {
      storeUpdateRecord(name, { state: 'up-to-date', latest: currentVersion ?? best, message: '已是最新' })
      return
    }
    storeUpdateRecord(name, {
      state: currentVersion === null ? 'unknown' : 'available',
      latest: best,
      message: currentVersion === null ? `最新标签 ${best}（未记录当前版本）` : `发现新版本 ${best}`,
    })
  }

  /** 执行一次更新流程（按检测到的方式分派；异常一律落到 failed）。 */
  async function performSkillUpdate(name, apply) {
    const entry = state.known[name]
    const method = entry && UPDATE_METHODS.has(entry.updateMethod) ? entry.updateMethod : 'none'
    if (entry === undefined) {
      storeUpdateRecord(name, { state: 'failed', message: '技能不存在' })
      return
    }
    if (method === 'bundled') {
      storeUpdateRecord(name, { state: 'not-applicable', message: '内置技能请通过 DSH 插件更新' })
      return
    }
    if (method === 'none') {
      const message = typeof entry.scriptPath === 'string' ? '仅支持 Python 更新脚本' : '无关联代码仓'
      storeUpdateRecord(name, { state: 'not-applicable', message })
      return
    }
    storeUpdateRecord(name, { state: 'checking' })
    try {
      if (method === 'script') await runScriptUpdate(name, entry, apply)
      else if (method === 'metadata') await runMetadataUpdate(name, entry, apply)
      else await runGitUpdate(name, entry, apply, method)
    } catch (err) {
      storeUpdateRecord(name, { state: 'failed', message: truncateText(err && err.message !== undefined ? err.message : err, MAX_UPDATE_MESSAGE) })
    }
  }

  /**
   * 单技能单飞执行：并发调用（含同一技能的 check/apply）只会有一个命令在跑，
   * 后者直接返回（payload 里能看到 busy=true）。
   * @param {string} name - 技能名。
   * @param {boolean} apply - 是否执行更新。
   */
  async function runSkillUpdateAction(name, apply) {
    if (updateInFlight.has(name)) return
    const task = (async () => {
      try {
        await performSkillUpdate(name, apply)
      } catch (err) {
        storeUpdateRecord(name, { state: 'failed', message: truncateText(err && err.message !== undefined ? err.message : err, MAX_UPDATE_MESSAGE) })
      } finally {
        updateInFlight.delete(name)
      }
    })()
    updateInFlight.set(name, task)
    await task
  }

  /* ---------------------- 工作区选择器（契约 v2 §D） ---------------------- */

  /**
   * 组装工作区选择器数据：registry 顺序、≤150 条。
   * workspaceRegistry 缺失时返回空数组（契约明确不做 cwd 归并推导）。
   * @returns {{ id: string, title: string, path: string, sessions: number }[]}
   */
  function listWorkspacesForPicker() {
    const registry = workspaceRegistryService()
    if (!registry) return []
    let list = []
    try {
      list = registry.list()
    } catch (err) {
      log.warn(`读取工作区清单失败：${err.message}`)
      return []
    }
    const workspaces = []
    for (const workspace of Array.isArray(list) ? list : []) {
      if (workspace === null || typeof workspace !== 'object') continue
      if (!isWorkspaceId(workspace.id)) continue
      workspaces.push({
        id: workspace.id,
        title: typeof workspace.title === 'string' ? workspace.title : '',
        path: typeof workspace.path === 'string' ? workspace.path : '',
        sessions: Array.isArray(workspace.sessionIds) ? workspace.sessionIds.length : 0,
      })
      if (workspaces.length >= MAX_PICKER_WORKSPACES) break
    }
    return workspaces
  }

  /* ---------------------- payload 组装（§2） ---------------------- */

  /** 技能是否允许删除：来源可删、不在安装目录、且 SKILL.md 仍存在。 */
  function isDeletable(entry) {
    if (!entry || !DELETABLE_SOURCES.has(entry.source)) return false
    if (isInstalledPackagePath(entry.path)) return false
    return typeof entry.path === 'string' && entry.path.length > 0 && pathExists(entry.path)
  }

  /** 组装 GET / POST 共用的 payload（同步部分 + 工作区列表）。 */
  async function buildPayload() {
    const calls = new Map()
    const lastUsed = new Map()
    for (const record of Object.values(state.stats.sessions)) {
      if (record === null || typeof record !== 'object') continue
      const at = toNonNegativeInt(record.lastUsedAt)
      for (const [skillName, count] of Object.entries(record.skills ?? {})) {
        const hits = toNonNegativeInt(count)
        if (hits > 0) calls.set(skillName, (calls.get(skillName) ?? 0) + hits)
        if (at > (lastUsed.get(skillName) ?? 0)) lastUsed.set(skillName, at)
      }
    }

    const disabled = new Set(state.disabled)
    const skills = []
    const displayedTagLists = []
    for (const [skillName, entry] of Object.entries(state.known)) {
      if (!isSkillName(skillName) || entry === null || typeof entry !== 'object') continue
      const bound = Array.isArray(state.bindings[skillName]) ? state.bindings[skillName].filter(isWorkspaceId) : []
      const tags = displayTagsFor(skillName)
      displayedTagLists.push(tags)
      const tagEntry = state.tags[skillName]
      const mutedTags = tagEntry !== undefined && tagEntry !== null && Array.isArray(tagEntry.muted) ? [...tagEntry.muted] : []
      const installedAt = toNonNegativeInt(entry.installedAt)
      const updatedAt = toNonNegativeInt(entry.updatedAt)
      skills.push({
        name: skillName,
        description: typeof entry.description === 'string' ? entry.description : '',
        source: typeof entry.source === 'string' ? entry.source : 'unknown',
        provider: typeof entry.provider === 'string' ? entry.provider : 'unknown',
        path: typeof entry.path === 'string' ? entry.path : '',
        enabled: !disabled.has(skillName),
        boundWorkspaces: [...bound],
        calls: calls.get(skillName) ?? 0,
        lastUsedAt: lastUsed.get(skillName) ?? null,
        deletable: isDeletable(entry),
        installedAt: installedAt > 0 ? installedAt : null,
        updatedAt: updatedAt > 0 ? updatedAt : null,
        tags,
        mutedTags,
        // 契约 v4：版本 / 代码仓 / 更新状态（GET 只读缓存，不执行任何命令）。
        version: typeof entry.version === 'string' ? entry.version : null,
        repoUrl: typeof entry.repoUrl === 'string' ? entry.repoUrl : null,
        update: updateViewFor(skillName),
      })
    }
    skills.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))

    const summary = { total: skills.length, enabled: 0, disabled: 0, bound: 0, calls: 0 }
    for (const skill of skills) {
      if (skill.enabled) summary.enabled += 1
      else summary.disabled += 1
      if (skill.boundWorkspaces.length > 0) summary.bound += 1
      summary.calls += skill.calls
    }

    // 当前工作区：优先部署默认目录；否则取任一 live Agent 的工作区（界面上「当前」标记）。
    const currentWorkspace = currentWorkspaceOf()

    return {
      version: STATE_VERSION,
      skills,
      workspaces: listWorkspacesForPicker(),
      tags: buildTagCounts(displayedTagLists),
      tagging: tagPayload(),
      client: { lastError: clientReport.message, lastAt: clientReport.at },
      summary,
      stats: {
        scanning: scanState.scanning,
        updatedAt: state.stats.updatedAt,
        scannedSessions: Object.keys(state.stats.sessions).length,
        totalSessions: scanState.totalSessions,
      },
      // 清单扫描状态：GET 不再等待扫描，客户端据此决定是否轮询/显示填入中。
      inventory: {
        ready: inventoryReady,
        refreshing: inventoryPending !== null,
        updatedAt: inventoryUpdatedAt,
      },
      trashDir: trashDirectory(),
      currentWorkspaceId: currentWorkspace && typeof currentWorkspace.id === 'string' ? currentWorkspace.id : null,
      currentWorkspacePath: currentWorkspace && typeof currentWorkspace.path === 'string' ? currentWorkspace.path : null,
    }
  }

  /* ---------------------- 变更动作（§4.5 / 动作表） ---------------------- */

  /** 保证技能存在于清单；必要时补一次扫描。 */
  async function ensureKnownSkill(skillName) {
    if (state.known[skillName]) return true
    await refreshInventory()
    return Boolean(state.known[skillName])
  }

  /** 启用 / 禁用。 */
  async function setSkillEnabled(skillName, enabled) {
    if (!(await ensureKnownSkill(skillName))) throw notFound(`技能 "${skillName}" 不存在`)
    if (enabled) {
      const at = state.disabled.indexOf(skillName)
      if (at !== -1) state.disabled.splice(at, 1)
    } else if (!state.disabled.includes(skillName)) {
      state.disabled.push(skillName)
      state.disabled.sort()
    }
    persist()
    invalidate()
  }

  /** 设置会话绑定；空数组表示解除绑定。 */
  /** 设置工作区绑定（契约 v2）；空数组表示解除绑定。 */
  async function setSkillWorkspaces(skillName, workspaces) {
    if (!(await ensureKnownSkill(skillName))) throw notFound(`技能 "${skillName}" 不存在`)
    const unique = []
    const seen = new Set()
    for (const value of workspaces) {
      if (!isWorkspaceId(value)) throw invalidRequest('workspaces 只能包含合法工作区 id')
      if (seen.has(value)) continue
      seen.add(value)
      unique.push(value)
    }
    if (unique.length > MAX_BINDINGS) {
      throw invalidRequest(`最多绑定 ${MAX_BINDINGS} 个工作区`)
    }
    if (unique.length === 0) delete state.bindings[skillName]
    else state.bindings[skillName] = unique
    persist()
    invalidate()
  }

  /**
   * 设置标签（契约 v3 §2）：user / muted 各自「传了才替换，未传保持」。
   * 标签不影响技能目录，因此只 persist，不调用 invalidate()。
   * @param {string} skillName - 技能名。
   * @param {string[]|undefined} userTags - 用户标签（undefined = 保持）。
   * @param {string[]|undefined} mutedTags - 被屏蔽的 AI 标签（undefined = 保持）。
   */
  async function setSkillTags(skillName, userTags, mutedTags) {
    if (!(await ensureKnownSkill(skillName))) throw notFound(`技能 "${skillName}" 不存在`)
    if (userTags !== undefined && !Array.isArray(userTags)) throw invalidRequest('user 必须是标签数组')
    if (mutedTags !== undefined && !Array.isArray(mutedTags)) throw invalidRequest('muted 必须是标签数组')
    const existing = tagEntryFor(skillName)
    const next = {
      ai: existing.ai,
      user: userTags === undefined ? existing.user : (sanitizeTagList(userTags) ?? []),
      muted: mutedTags === undefined ? existing.muted : (sanitizeTagList(mutedTags) ?? []),
      aiAt: existing.aiAt,
    }
    if (next.ai.length === 0 && next.user.length === 0 && next.muted.length === 0) delete state.tags[skillName]
    else state.tags[skillName] = next
    persist()
  }

  /**
   * 判定技能目录：优先使用 SKILL.md 所在目录；目录名必须等于技能名。
   * @returns {string|undefined} 可删除的绝对目录，无法判定时返回 undefined。
   */
  function resolveSkillDirectory(file, skillName) {
    const parent = path.dirname(file)
    const base = path.basename(file).toLowerCase()
    let directory = base === 'skill.md' ? parent : file
    if (path.basename(directory) !== skillName) {
      if (path.basename(parent) === skillName) directory = parent
      else return undefined
    }
    const resolved = path.resolve(directory)
    // 拒绝删除文件系统根目录（理论上 basename 检查已排除）。
    if (path.dirname(resolved) === resolved) return undefined
    return resolved
  }

  /** 计算一个不冲突的回收站目标路径。 */
  function trashTarget(skillName) {
    const base = `${trashStamp(new Date())}-${skillName}`
    const directory = trashDirectory()
    let candidate = path.join(directory, base)
    for (let index = 2; index < 100 && pathExists(candidate); index += 1) {
      candidate = path.join(directory, `${base}-${index}`)
    }
    return candidate
  }

  /** 删除技能：目录移入回收站，并从状态里移除。 */
  async function deleteSkill(skillName) {
    const entry = state.known[skillName]
    if (!entry) throw notFound(`技能 "${skillName}" 不存在`)
    if (!DELETABLE_SOURCES.has(entry.source)) {
      throw forbidden(`来源为 "${entry.source}" 的技能不允许删除（内置技能受保护）`)
    }
    if (isInstalledPackagePath(entry.path)) {
      throw forbidden(`技能 "${skillName}" 位于安装目录的 node_modules 内，不允许删除（随包升级管理）`)
    }
    const file = typeof entry.path === 'string' && entry.path.length > 0 ? entry.path : undefined
    if (file === undefined) throw notFound(`技能 "${skillName}" 没有可删除的文件路径`)
    if (!pathExists(file)) throw notFound(`技能 "${skillName}" 的文件已不存在`)

    const directory = resolveSkillDirectory(file, skillName)
    if (directory === undefined) throw forbidden(`无法确定技能 "${skillName}" 的目录，已拒绝删除`)

    const target = trashTarget(skillName)
    try {
      fs.mkdirSync(trashDirectory(), { recursive: true })
    } catch (err) {
      throw new HttpError(500, 'internal', `无法创建回收站目录：${err.message}`)
    }

    try {
      fs.renameSync(directory, target)
    } catch {
      // 跨卷 / 被占用时退化为复制后删除。
      try {
        fs.cpSync(directory, target, { recursive: true, force: false, errorOnExist: true })
        fs.rmSync(directory, { recursive: true, force: true })
      } catch (copyError) {
        throw new HttpError(500, 'internal', `移动技能目录失败：${copyError.message}`)
      }
    }

    state.disabled = state.disabled.filter((value) => value !== skillName)
    delete state.bindings[skillName]
    delete state.known[skillName]
    delete state.tags[skillName]
    persist()
    invalidate()
    log.info(`技能 "${skillName}" 已移入回收站：${target}`)
    return target
  }

  /* -------------------------- provider（§4.2） -------------------------- */

  /**
   * 计算需要隐藏的技能名集合：已禁用 + 「绑定工作区不匹配当前 cwd」的技能。
   * 绑定技能在没有 cwd 或无法归属到任何工作区时一律隐藏（契约 v2 §B）。
   * @returns {Set<string>}
   */
  function hiddenSkillNames(options) {
    const hidden = new Set()
    for (const skillName of state.disabled) {
      if (isRegistrySkillName(skillName)) hidden.add(skillName)
    }
    const workspace = workspaceForCwd(cwdFromLookupOptions(options))
    const workspaceId = workspace && typeof workspace.id === 'string' ? workspace.id : undefined
    for (const [skillName, bound] of Object.entries(state.bindings)) {
      if (!Array.isArray(bound) || bound.length === 0) continue
      // 命中当前工作区 → 不隐藏；否则（含无 cwd / 无匹配工作区）隐藏。
      if (workspaceId !== undefined && bound.includes(workspaceId)) continue
      if (isRegistrySkillName(skillName)) hidden.add(skillName)
    }
    return hidden
  }

  /** 构造影子候选（模型/用户都不可调用，rank 压过真实 provider）。 */
  function shadowCandidate(skillName) {
    const known = state.known[skillName]
    const description = known && typeof known.description === 'string' && known.description.length > 0
      ? known.description
      : FALLBACK_DESCRIPTION
    return {
      name: skillName,
      description,
      invocation: { modelInvocable: false, userInvocable: false },
      source: 'runtime',
      provider: PROVIDER_NAME,
      rank: SHADOW_RANK,
      locator: { shadow: true },
    }
  }

  /**
   * provider 的 list：纯内存计算，绝不抛出（抛错会打断 agent step）。
   * @param {object} options - { cwd?, scope?, signal? }
   * @returns {Promise<object[]>} 影子候选数组。
   */
  async function listShadowCandidates(options) {
    try {
      const hidden = hiddenSkillNames(options)
      if (hidden.size === 0) return []
      const candidates = []
      for (const skillName of hidden) candidates.push(shadowCandidate(skillName))
      return candidates
    } catch (err) {
      log.warn(`计算技能门禁失败：${err.message}`)
      return []
    }
  }

  /* ------------------- 按 Agent 作用域注册门禁 provider ------------------- */

  /** 取 Agent 的稳定 id（Agent.id === SessionId）。 */
  function agentIdOf(agent) {
    return agent && typeof agent === 'object' && typeof agent.id === 'string' && agent.id.length > 0
      ? agent.id
      : undefined
  }

  /** 创建本插件的 provider（list 纯内存、绝不抛出；get 返回 undefined）。 */
  function createScopedProvider(entry) {
    return (control) => {
      if (control && typeof control.invalidate === 'function') {
        entry.control = control
        liveProviderControls.add(control)
      }
      return {
        name: PROVIDER_NAME,
        async list(options) {
          return listShadowCandidates(options)
        },
        async get() {
          return undefined
        },
      }
    }
  }

  /** 移除一条 agent provider 记录（不主动 dispose，Agent 作用域卸载会负责）。 */
  function forgetAgentProvider(agentId, agent) {
    const entry = agentProviders.get(agentId)
    if (!entry) return
    if (agent !== undefined && entry.agent !== agent) return
    if (entry.control) liveProviderControls.delete(entry.control)
    agentProviders.delete(agentId)
  }

  /** 在 Agent 自己的作用域（agent.ctx）里注册门禁 provider。 */
  function attachAgent(agent) {
    try {
      const agentId = agentIdOf(agent)
      if (agentId === undefined) return false
      const existing = agentProviders.get(agentId)
      if (existing && existing.agent === agent) return true
      if (existing) forgetAgentProvider(agentId, existing.agent)

      const scopeCtx = agent.ctx
      // 优先 ctx.get('skills')（不要求 inject 声明）；桩上下文退回属性访问。
      const scopedSkills = scopeCtx && typeof scopeCtx === 'object'
        ? (typeof scopeCtx.get === 'function' ? scopeCtx.get('skills') : scopeCtx.skills)
        : undefined
      if (!scopedSkills || typeof scopedSkills.registerProvider !== 'function') {
        if (!warnedAgentScopeMissing) {
          warnedAgentScopeMissing = true
          log.warn('Agent 作用域不可用（agent.ctx.skills 缺失），已跳过该会话的技能门禁')
        }
        return false
      }

      const entry = { agent, disposer: () => {}, control: undefined }
      // 关键：在 agent.ctx 上取 skills，registerProvider 会注册进该 Agent 的层，
      // 从而以同层 rank -1e9 压过 preset 作用域里的 skill-filesystem 候选。
      const disposer = scopedSkills.registerProvider(createScopedProvider(entry))
      entry.disposer = typeof disposer === 'function' ? disposer : () => {}
      agentProviders.set(agentId, entry)
      // 新注册会失效 registry 缓存；下一轮清单刷新把该作用域的技能并入 known。
      // allowQueued=true：若当前正有扫描在跑，补扫一次以纳入这个新作用域。
      scheduleInventoryRefresh(true)
      return true
    } catch (err) {
      log.warn(`注册 Agent 技能门禁失败：${err.message}`)
      return false
    }
  }

  /** 为所有已存在的 live Agent 挂上门禁（apply 时调用）。 */
  function attachKnownAgents() {
    const agents = service('agents')
    let liveAgents = []
    try {
      liveAgents = agents && typeof agents.list === 'function' ? agents.list() : []
    } catch (err) {
      log.warn(`列出 live Agent 失败：${err.message}`)
    }
    for (const agent of Array.isArray(liveAgents) ? liveAgents : []) attachAgent(agent)
  }

  /** 卸载时清理所有 agent provider（Agent 作用域卸载时也会自行清理）。 */
  function detachAllAgents() {
    for (const [agentId, entry] of agentProviders) {
      if (entry.control) liveProviderControls.delete(entry.control)
      try {
        entry.disposer()
      } catch (err) {
        log.warn(`移除 Agent 技能门禁失败：${err.message}`)
      }
      agentProviders.delete(agentId)
    }
  }

  /* ---------------------- 只读调试解析（debug=resolve） ---------------------- */

  /** 把注册表 list() 结果映射成 `{name, provider, modelInvocable}` 并按 name 升序。 */
  function summarizeRegistrySkills(list) {
    const rows = []
    for (const summary of Array.isArray(list) ? list : []) {
      if (summary === null || typeof summary !== 'object') continue
      if (typeof summary.name !== 'string') continue
      rows.push({
        name: summary.name,
        provider: typeof summary.provider === 'string' ? summary.provider : '',
        modelInvocable: summary.invocation?.modelInvocable === true,
      })
    }
    rows.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    return rows
  }

  /** 组装 `ctx.skills.list()` 的 lookup 选项；cwd 未知时省略以走默认根。 */
  function registryLookupOptions(scope, cwd) {
    const options = {}
    const effectiveCwd = typeof cwd === 'string' && cwd.length > 0 ? cwd : inventoryCwd()
    if (effectiveCwd !== undefined) options.cwd = effectiveCwd
    if (scope !== undefined) options.scope = scope
    return options
  }

  /**
   * `GET ?debug=resolve[&session=<id>][&cwd=<path>]`：只读解析 `ctx.skills` 注册表，
   * 不改任何状态。
   * - `cwd` 参数存在时，global / session 的查找都用它（否则用部署默认目录）；
   * - workspace = `workspaceForCwd(cwd)`（找不到为 null）；
   * - global = 无 scope 的胜出技能；session = 给定 live Agent 作用域下的胜出技能。
   * @param {URLSearchParams} params - 查询参数。
   * @returns {Promise<object>} { ok, debug, cwd, workspace, global, session, stats }。
   */
  async function resolveDebugPayload(params) {
    const requestedCwd = params.get('cwd')
    const explicitCwd = typeof requestedCwd === 'string' && requestedCwd.length > 0 ? requestedCwd : undefined

    // 先解析 Agent：未显式给 cwd 时，用该会话的真实工作目录（才能反映它所属的工作区）。
    let agent
    const sessionId = params.get('session')
    if (typeof sessionId === 'string' && sessionId.length > 0) {
      const agents = service('agents')
      try {
        agent = agents && typeof agents.get === 'function' ? agents.get(sessionId) : undefined
      } catch (err) {
        log.warn(`查找会话 ${sessionId} 对应 Agent 失败：${err.message}`)
        agent = undefined
      }
    }
    const cwd = explicitCwd ?? (agent === undefined ? inventoryCwd() : agentCwd(agent))
    const workspace = workspaceForCwd(cwd)

    const global = summarizeRegistrySkills(await ctx.skills.list(registryLookupOptions(undefined, cwd)))

    let session = null
    if (agent) session = summarizeRegistrySkills(await ctx.skills.list(registryLookupOptions(agent, cwd)))

    return {
      ok: true,
      debug: 'resolve',
      cwd: cwd === undefined ? null : cwd,
      workspace: workspace === undefined
        ? null
        : {
            id: typeof workspace.id === 'string' ? workspace.id : '',
            title: typeof workspace.title === 'string' ? workspace.title : '',
            path: typeof workspace.path === 'string' ? workspace.path : '',
          },
      global,
      session,
      stats: { scanning: scanState.scanning, updatedAt: state.stats.updatedAt },
    }
  }

  /* ---------------------------- 路由（§4.6） ---------------------------- */

  /** 读取请求体；超过上限抛 400。 */
  function readBody(request, limit) {
    return new Promise((resolve, reject) => {
      const chunks = []
      let size = 0
      let settled = false

      const cleanup = () => {
        request.removeListener('data', onData)
        request.removeListener('end', onEnd)
        request.removeListener('error', onError)
        request.removeListener('aborted', onAborted)
      }
      const settle = (callback, value) => {
        if (settled) return
        settled = true
        cleanup()
        callback(value)
      }
      const onData = (chunk) => {
        if (settled) return
        size += chunk.length
        if (size > limit) {
          settle(reject, invalidRequest(`请求体超过 ${Math.floor(limit / 1024)} KiB 上限`))
          try {
            request.resume()
          } catch {
            /* 忽略 */
          }
          return
        }
        chunks.push(chunk)
      }
      const onEnd = () => settle(resolve, Buffer.concat(chunks).toString('utf8'))
      const onError = (err) => settle(reject, invalidRequest(`读取请求体失败：${err.message}`))
      const onAborted = () => settle(reject, invalidRequest('请求被中断'))

      request.on('data', onData)
      request.on('end', onEnd)
      request.on('error', onError)
      request.on('aborted', onAborted)
    })
  }

  /** 写出 JSON 响应；响应已发出时安全忽略。 */
  function sendJson(response, status, value, omitBody) {
    try {
      if (response.writableEnded === true || response.headersSent === true) {
        try {
          response.end()
        } catch {
          /* 忽略 */
        }
        return
      }
      const body = JSON.stringify(value)
      response.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(body),
      })
      response.end(omitBody === true ? undefined : body)
    } catch (err) {
      log.warn(`写出响应失败：${err.message}`)
      try {
        response.destroy?.()
      } catch {
        /* 忽略 */
      }
    }
  }

  /** 统一错误响应。 */
  function sendError(response, status, code, message) {
    sendJson(response, status, { ok: false, error: { code, message } }, false)
  }

  /** 校验并执行一个 POST action，返回最新 payload。 */
  async function dispatchAction(body) {
    const action = typeof body?.action === 'string' ? body.action : ''
    switch (action) {
      case 'setEnabled': {
        const skillName = body?.name
        if (!isSkillName(skillName)) throw invalidRequest('name 必须匹配 ^[a-z0-9][a-z0-9-]{0,63}$')
        if (typeof body?.enabled !== 'boolean') throw invalidRequest('enabled 必须是布尔值')
        await setSkillEnabled(skillName, body.enabled)
        break
      }
      case 'setWorkspaces': {
        const skillName = body?.name
        if (!isSkillName(skillName)) throw invalidRequest('name 必须匹配 ^[a-z0-9][a-z0-9-]{0,63}$')
        if (!Array.isArray(body?.workspaces)) throw invalidRequest('workspaces 必须是工作区 id 数组')
        await setSkillWorkspaces(skillName, body.workspaces)
        break
      }
      case 'setBindings': {
        // 兼容旧 action 名：只有携带 workspaces 数组时才接受；sessions 数组一律 400。
        if (!Array.isArray(body?.workspaces)) {
          throw invalidRequest('setBindings 已改为按工作区绑定，请使用 setWorkspaces 并提供 workspaces 数组')
        }
        const skillName = body?.name
        if (!isSkillName(skillName)) throw invalidRequest('name 必须匹配 ^[a-z0-9][a-z0-9-]{0,63}$')
        await setSkillWorkspaces(skillName, body.workspaces)
        break
      }
      case 'delete': {
        const skillName = body?.name
        if (!isSkillName(skillName)) throw invalidRequest('name 必须匹配 ^[a-z0-9][a-z0-9-]{0,63}$')
        await deleteSkill(skillName)
        break
      }
      case 'setTags': {
        const skillName = body?.name
        if (!isSkillName(skillName)) throw invalidRequest('name 必须匹配 ^[a-z0-9][a-z0-9-]{0,63}$')
        if (body.user !== undefined && !Array.isArray(body.user)) throw invalidRequest('user 必须是标签数组')
        if (body.muted !== undefined && !Array.isArray(body.muted)) throw invalidRequest('muted 必须是标签数组')
        await setSkillTags(skillName, body.user, body.muted)
        break
      }
      case 'tagNow': {
        // 立刻强制跑一轮（不等待结果），客户端轮询 tagging.running/queued。
        kickTagNow()
        break
      }
      case 'skillUpdate': {
        // 契约 v4：检查 / 执行更新。发起请求等到命令结束；并发请求看到 busy=true 立即返回。
        const skillName = body?.name
        if (!isSkillName(skillName)) throw invalidRequest('name 必须匹配 ^[a-z0-9][a-z0-9-]{0,63}$')
        if (body.apply !== undefined && typeof body.apply !== 'boolean') throw invalidRequest('apply 必须是布尔值')
        const apply = body.apply === true
        if (!(await ensureKnownSkill(skillName))) throw notFound(`技能 "${skillName}" 不存在`)
        ensureUpdateDetection(skillName)
        await runSkillUpdateAction(skillName, apply)
        break
      }
      case 'reportClientError': {
        // 客户端 slot 注册失败等诊断上报（仅内存态，回报在 payload.client）。
        const message = typeof body?.message === 'string' ? body.message.slice(0, 800) : ''
        if (message.length > 0) {
          clientReport.message = message
          clientReport.at = Date.now()
        }
        break
      }
      case 'refreshStats': {
        void scanStats()
        break
      }
      case 'refresh': {
        await refreshInventory()
        break
      }
      default:
        throw invalidRequest(action.length > 0 ? `未知 action "${action}"` : '缺少 action')
    }
    return buildPayload()
  }

  /** HTTP 入口：GET 返回 payload，POST 分发 action。 */
  async function handleRequest(request, response) {
    try {
      const method = typeof request.method === 'string' ? request.method.toUpperCase() : ''
      const pathname = pathnameOf(request.url)
      if (pathname !== ROUTE_PATH) {
        sendError(response, 404, 'not-found', '未知路由')
        return
      }

      if (method === 'GET' || method === 'HEAD') {
        // 只读调试入口：必须最先处理，且不触发扫描 / 清单刷新等任何状态变化。
        const params = searchParamsOf(request.url)
        const debug = params === null ? null : params.get('debug')
        if (debug !== null) {
          if (debug !== 'resolve') throw invalidRequest(`未知 debug 参数 "${debug}"`)
          const debugPayload = await resolveDebugPayload(params)
          sendJson(response, 200, debugPayload, method === 'HEAD')
          return
        }

        // 首次访问时触发一次后台统计（不 await）。
        if (state.stats.updatedAt === 0) void scanStats()
        // 技能清单永不在 GET 里等待：打开面板必须立刻返回（客户端按 inventory.refreshing 轮询）。
        // 仅在「没有正在进行的刷新」且「未就绪 / 已过期」时把刷新丢到后台。
        const refreshing = inventoryPending !== null
        if (!refreshing) {
          if (!inventoryReady && Date.now() >= inventoryRetryAt) void refreshInventory()
          else if (inventoryReady && Date.now() - inventoryUpdatedAt > INVENTORY_TTL_MS) void refreshInventory()
        }

        const payload = await buildPayload()
        sendJson(response, 200, { ok: true, ...payload }, method === 'HEAD')
        return
      }

      if (method === 'POST') {
        let rawBody
        try {
          rawBody = await readBody(request, MAX_BODY_BYTES)
        } catch (err) {
          if (err instanceof HttpError) {
            sendError(response, err.status, err.code, err.message)
            return
          }
          throw err
        }
        let body = {}
        if (rawBody.trim().length > 0) {
          try {
            body = JSON.parse(rawBody)
          } catch {
            throw invalidRequest('请求体必须是合法 JSON')
          }
        }
        if (body === null || typeof body !== 'object' || Array.isArray(body)) {
          throw invalidRequest('请求体必须是 JSON 对象')
        }
        const payload = await dispatchAction(body)
        sendJson(response, 200, { ok: true, payload }, false)
        return
      }

      sendError(response, 405, 'invalid-request', `不支持的请求方法：${method || '(空)'}`)
    } catch (err) {
      if (err instanceof HttpError) {
        sendError(response, err.status, err.code, err.message)
        return
      }
      log.warn(`处理 ${pathnameOf(request.url)} 时出错：${err instanceof Error ? err.message : String(err)}`)
      sendError(response, 500, 'internal', err instanceof Error ? err.message : '内部错误')
    }
  }

  /* ---------------------------- 装配 ---------------------------- */

  // 1) 作用域门禁：已存在的 Agent 立刻挂上；之后每个 agent/created 都挂一个。
  //    agent 作用域卸载时 provider 由 Cordis 自动注销；这里额外在 dispose 时兜底清理。
  registerEffect(() => {
    attachKnownAgents()
    const listeners = []
    try {
      listeners.push(ctx.on('agent/created', (payload) => {
        try {
          const agent = payload?.agent
          if (agent) attachAgent(agent)
        } catch (err) {
          log.warn(`处理 agent/created 失败：${err.message}`)
        }
      }))
    } catch (err) {
      log.warn(`监听 agent/created 失败：${err.message}`)
    }
    try {
      listeners.push(ctx.on('agent/disposed', (payload) => {
        try {
          const agent = payload?.agent
          const agentId = agentIdOf(agent)
          if (agentId !== undefined) {
            forgetAgentProvider(agentId, agent)
            scheduleInventoryRefresh(true)
          }
        } catch (err) {
          log.warn(`处理 agent/disposed 失败：${err.message}`)
        }
      }))
    } catch (err) {
      log.warn(`监听 agent/disposed 失败：${err.message}`)
    }
    return () => {
      for (const dispose of listeners) {
        try {
          if (typeof dispose === 'function') dispose()
        } catch {
          /* 忽略 */
        }
      }
      if (inventoryRefreshTimer !== null) {
        clearTimeout(inventoryRefreshTimer)
        inventoryRefreshTimer = null
      }
      inventoryRefreshRequested = false
      detachAllAgents()
    }
  }, 'skill-manager: agent-scoped gating')

  // 2) 技能目录变化（安装 / 卸载 / 热更新）→ 防抖后重扫清单。
  registerEffect(() => {
    try {
      return ctx.on('skills/change', () => {
        // 工作区投影也可能随安装/更新变化：先丢缓存，再防抖重扫清单。
        invalidateWorkspaceCache()
        scheduleInventoryRefresh()
      })
    } catch (err) {
      log.warn(`监听 skills/change 失败：${err.message}`)
      return () => {}
    }
  }, 'skill-manager: skills change listener')

  // 3) HTTP 路由（register 返回 disposer，卸载时自动摘除）。
  registerEffect(() => ctx.webServer.register({ path: ROUTE_PATH, handler: handleRequest }), 'skill-manager: http api')

  // 4) AI 标签：apply 后按 tagDelayMs 调度一次；卸载时清理定时器并中止进行中的请求。
  registerEffect(() => {
    if (tagConfig.autoTagEnabled) scheduleTagRun(tagConfig.tagDelayMs)
    return () => {
      clearTagTimer()
      try {
        tagLifecycle.abort()
      } catch {
        /* 忽略 abort 异常 */
      }
    }
  }, 'skill-manager: ai tagging')

  // 5) 后台预热技能清单（不阻塞 apply）。
  void refreshInventory()

  log.info(`已加载：路由 ${ROUTE_PATH}，已知技能 ${Object.keys(state.known).length} 个`)
}

/* ------------------------------------------------------------------ *
 * 日志：优先用 ctx.logger，缺失时静默。
 * ------------------------------------------------------------------ */

/**
 * 生成显式日志器。`ctx.logger` 不存在时所有级别都是 no-op。
 * @param {object} ctx - Cordis 上下文。
 */
function createLogger(ctx) {
  const logger = ctx && typeof ctx === 'object' ? ctx.logger : undefined
  const emit = (level, message) => {
    if (!logger) return
    const method = logger[level]
    if (typeof method === 'function') {
      try {
        method.call(logger, `[skill-manager] ${message}`)
      } catch {
        /* 日志失败不影响业务 */
      }
    }
  }
  return {
    info: (message) => emit('info', message),
    warn: (message) => emit('warn', message),
    error: (message) => emit('error', message),
    debug: (message) => emit('debug', message),
  }
}
