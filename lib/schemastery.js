/**
 * lib/schemastery.js —— 从宿主树里找 `@deepseek-ai/schemastery`，拿不到就返回 null。
 * ============================================================================
 * 本插件以本地目录 link 进 profile，真实的模块目录是工作区路径，bare import
 * 解析不到宿主包；所以按 DSH_PROFILE_DIR / DSH_HOME / 常见安装位置逐棵查找。
 * 找不到时 Config 为 undefined：loader 不做 schema 校验，插件本体照常工作。
 * ============================================================================
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'

const PKG = '@deepseek-ai/schemastery'

/** 读取一个包目录的入口文件 URL（优先 exports['.']，退回 main/module）。 */
function entryUrl(packageDir) {
  try {
    const pkgFile = join(packageDir, 'package.json')
    if (!existsSync(pkgFile)) return null
    const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
    const dot = pkg.exports?.['.']
    const rel = typeof dot === 'string'
      ? dot
      : dot?.import ?? dot?.default ?? dot?.require ?? pkg.module ?? pkg.main
    if (typeof rel !== 'string') return null
    const file = join(packageDir, rel.replace(/^\.\//, ''))
    return existsSync(file) ? pathToFileURL(file).href : null
  } catch {
    return null
  }
}

/** 候选包目录（去重、只保留存在的）。 */
function candidateDirs() {
  const dirs = []
  const push = (dir) => {
    if (dir && !dirs.includes(dir)) dirs.push(dir)
  }
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  if (process.env.DSH_PROFILE_DIR) push(join(process.env.DSH_PROFILE_DIR, 'node_modules', PKG))
  if (process.env.DSH_HOST_MODULES) push(join(process.env.DSH_HOST_MODULES, PKG))
  try {
    for (const profile of readdirSync(join(dshHome, 'profiles'))) {
      push(join(dshHome, 'profiles', profile, 'node_modules', PKG))
    }
  } catch {
    /* 没有 profiles 目录 */
  }
  push(join(dshHome, 'node_modules', PKG))
  return dirs
}

/**
 * 加载 schemastery 的 `z`。
 * @returns {Promise<any|null>}
 */
export async function loadSchemastery() {
  for (const dir of candidateDirs()) {
    const url = entryUrl(dir)
    if (!url) continue
    try {
      const mod = await import(url)
      const z = mod?.default ?? mod
      if (typeof z?.object === 'function') return z
    } catch {
      /* 换下一棵树 */
    }
  }
  try {
    const mod = await import(PKG)
    const z = mod?.default ?? mod
    if (typeof z?.object === 'function') return z
  } catch {
    /* 宿主树里也没有 */
  }
  return null
}
