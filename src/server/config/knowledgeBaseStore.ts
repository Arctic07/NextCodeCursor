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

/** 读取所有 items;文件不存在 / 损坏返回空数组。 */
export function listKnowledgeItems(): KnowledgeItem[] {
  const loaded = readJsonOrNull<Partial<KnowledgeBaseFile>>(getKnowledgeBaseFilePath())
  return normalize(loaded).items.slice()
}

/** 追加一条 item,返回新生成的 id。 */
export async function addKnowledgeItem(input: {
  knowledge: string
  title: string
  isGenerated?: boolean
}): Promise<KnowledgeItem> {
  const path = getKnowledgeBaseFilePath()
  return withSerial(path, () => {
    const file = normalize(readJsonOrNull<Partial<KnowledgeBaseFile>>(path))
    const item: KnowledgeItem = {
      id: randomUUID(),
      knowledge: input.knowledge,
      title: input.title.trim() || '[Untitled]',
      createdAt: new Date().toISOString(),
      isGenerated: !!input.isGenerated,
    }
    // 新项排到最前,和官方 KnowledgeBaseService.addItem 的 UI 排序一致
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
