/**
 * knowledge-base.json 本地 CRUD
 *
 * 对应 Cursor 客户端 knowledgeBaseService 的后端存储。
 * 官方服务端把 items 存在用户账户云端;BYOK 这里用本地 JSON 替代。
 *
 * 数据形态:
 *   { items: [ { id, knowledge, title, createdAt, isGenerated } ] }
 *
 * 对外提供 list / add / update / remove,语义对齐 aiserver.v1.AiService
 * knowledgeBase{List,Add,Update,Remove} 四个端点。
 */
import { randomUUID } from 'node:crypto'
import { logger } from '../logger'
import { readJsonOrNull, withSerial, writeJsonAtomic } from './atomic'
import { getKnowledgeBaseFilePath } from './paths'

export interface KnowledgeItem {
  id: string
  knowledge: string
  title: string
  createdAt: string
  isGenerated: boolean
}

interface KnowledgeBaseFile {
  items: KnowledgeItem[]
}

function emptyFile(): KnowledgeBaseFile {
  return { items: [] }
}

function normalize(loaded: { items?: unknown } | null): KnowledgeBaseFile {
  if (!loaded || !Array.isArray(loaded.items))
    return emptyFile()
  const out: KnowledgeItem[] = []
  for (const raw of loaded.items) {
    if (!raw || typeof raw !== 'object')
      continue
    const it = raw as Partial<KnowledgeItem>
    out.push({
      id: typeof it.id === 'string' && it.id.length > 0 ? it.id : randomUUID(),
      knowledge: typeof it.knowledge === 'string' ? it.knowledge : '',
      title: typeof it.title === 'string' ? it.title : '[Untitled]',
      createdAt: typeof it.createdAt === 'string' ? it.createdAt : new Date().toISOString(),
      isGenerated: !!it.isGenerated,
    })
  }
  return { items: out }
}

/**
 * 读取所有 items;文件不存在 / 损坏返回空数组。
 *
 * 自愈: 如果检测到内容完全相同的重复条目 (title + knowledge),
 * 仅保留最早的一份并自动清理文件。这处理了 addKnowledgeItem
 * 幂等化之前累积的历史重复数据。
 */
export function listKnowledgeItems(): KnowledgeItem[] {
  const path = getKnowledgeBaseFilePath()
  const file = normalize(readJsonOrNull<Partial<KnowledgeBaseFile>>(path))

  const seen = new Map<string, KnowledgeItem>()
  const deduped: KnowledgeItem[] = []
  let duplicateCount = 0

  for (const item of file.items) {
    const contentKey = `${item.title}\0${item.knowledge}`
    if (seen.has(contentKey)) {
      duplicateCount++
      continue
    }
    seen.set(contentKey, item)
    deduped.push(item)
  }

  if (duplicateCount > 0) {
    file.items = deduped
    writeJsonAtomic(path, file)
    logger.info({ removed: duplicateCount, remaining: deduped.length }, '[CFG] knowledge-base self-heal: deduplicated')
  }

  return deduped.slice()
}

/**
 * 追加一条 item,返回新生成的 id。
 *
 * 幂等性保障: 若已存在内容完全相同 (knowledge + title) 的 item,
 * 返回已有 item 而不追加。这对齐官方 server 对 maybeAddOldUserRules()
 * 等重复迁移调用的去重行为 — 客户端在每次启动时都会调用
 * knowledgeBaseAdd("Migrated User Rules", personalContext),
 * 官方云端通过账户级唯一约束去重, BYOK 需要在存储层做同样的事。
 */
export async function addKnowledgeItem(input: {
  knowledge: string
  title: string
  isGenerated?: boolean
}): Promise<KnowledgeItem> {
  const path = getKnowledgeBaseFilePath()
  return withSerial(path, () => {
    const file = normalize(readJsonOrNull<Partial<KnowledgeBaseFile>>(path))
    const titleNorm = input.title.trim() || '[Untitled]'
    const knowledgeNorm = input.knowledge

    // 幂等: 内容相同的 item 不重复创建
    const existing = file.items.find(
      it => it.title === titleNorm && it.knowledge === knowledgeNorm,
    )
    if (existing) {
      logger.info({ id: existing.id, title: existing.title }, '[CFG] knowledge-base item already exists (idempotent)')
      return existing
    }

    const item: KnowledgeItem = {
      id: randomUUID(),
      knowledge: knowledgeNorm,
      title: titleNorm,
      createdAt: new Date().toISOString(),
      isGenerated: !!input.isGenerated,
    }
    file.items.unshift(item)
    writeJsonAtomic(path, file)
    logger.info({ id: item.id, title: item.title }, '[CFG] knowledge-base item added')
    return item
  })
}

/** 按 id 更新 knowledge + title。 */
export async function updateKnowledgeItem(id: string, patch: { knowledge?: string, title?: string }): Promise<boolean> {
  const path = getKnowledgeBaseFilePath()
  return withSerial(path, () => {
    const file = normalize(readJsonOrNull<Partial<KnowledgeBaseFile>>(path))
    const idx = file.items.findIndex(it => it.id === id)
    if (idx < 0)
      return false
    if (typeof patch.knowledge === 'string')
      file.items[idx].knowledge = patch.knowledge
    if (typeof patch.title === 'string')
      file.items[idx].title = patch.title.trim() || '[Untitled]'
    writeJsonAtomic(path, file)
    logger.info({ id }, '[CFG] knowledge-base item updated')
    return true
  })
}

/** 按 id 删除,返回是否命中。 */
export async function removeKnowledgeItem(id: string): Promise<boolean> {
  const path = getKnowledgeBaseFilePath()
  return withSerial(path, () => {
    const file = normalize(readJsonOrNull<Partial<KnowledgeBaseFile>>(path))
    const before = file.items.length
    file.items = file.items.filter(it => it.id !== id)
    if (file.items.length === before)
      return false
    writeJsonAtomic(path, file)
    logger.info({ id }, '[CFG] knowledge-base item removed')
    return true
  })
}
