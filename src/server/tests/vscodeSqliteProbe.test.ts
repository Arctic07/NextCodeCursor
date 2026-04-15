/**
 * 探针测试: 验证 Cursor 内置的 @vscode/sqlite3 native binding 的功能。
 *
 * Cursor (Electron) 自带 @vscode/sqlite3 模块，native binding 与 Electron ABI 匹配。
 * 通过 createRequire 从 Cursor app 路径加载，无需 bundle 或重新编译。
 *
 * 验证项：
 * 1. createRequire 加载路径
 * 2. 基础读写 (异步回调 API)
 * 3. WAL 模式支持
 * 4. 多连接并发
 * 5. 资源清理
 */
import type { existsSync as ExistsSync } from 'node:fs'
import { unlinkSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const CURSOR_APP_PATH = '/Applications/Cursor.app/Contents/Resources/app/'

const fs = require('node:fs') as { existsSync: typeof ExistsSync }

const cursorAppExists = fs.existsSync(CURSOR_APP_PATH)

describe.skipIf(!cursorAppExists)('@vscode/sqlite3 internal module probe', () => {
  let sqlite3: any
  let tmpDbPath = ''

  beforeEach(() => {
    tmpDbPath = join(tmpdir(), `vscode-sqlite3-probe-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  })

  afterEach(() => {
    try {
      unlinkSync(tmpDbPath)
    }
    catch {}
    try {
      unlinkSync(`${tmpDbPath}-wal`)
    }
    catch {}
    try {
      unlinkSync(`${tmpDbPath}-shm`)
    }
    catch {}
  })

  // ─── 1. 加载验证 ───

  it('loads via createRequire from Cursor app path', () => {
    const cursorRequire = createRequire(`${CURSOR_APP_PATH}package.json`)
    sqlite3 = cursorRequire('@vscode/sqlite3')

    expect(sqlite3).toBeTruthy()
    expect(sqlite3.Database).toBeTypeOf('function')
    expect(sqlite3.Statement).toBeTypeOf('function')
    expect(sqlite3.VERSION).toBeTypeOf('string')
  })

  it('exposes SQLite version constants', () => {
    const cursorRequire = createRequire(`${CURSOR_APP_PATH}package.json`)
    sqlite3 = cursorRequire('@vscode/sqlite3')

    expect(sqlite3.VERSION).toMatch(/^\d+\.\d+\.\d+/)
    expect(sqlite3.OK).toBe(0)
    expect(sqlite3.OPEN_READWRITE).toBeTypeOf('number')
    expect(sqlite3.OPEN_CREATE).toBeTypeOf('number')
  })

  // ─── 2. 基础读写 ───

  it('opens, writes, reads via async API', async () => {
    const cursorRequire = createRequire(`${CURSOR_APP_PATH}package.json`)
    sqlite3 = cursorRequire('@vscode/sqlite3')

    const result = await new Promise<any[]>((resolve, reject) => {
      const db = new sqlite3.Database(tmpDbPath, (err: Error | null) => {
        if (err)
          return reject(err)

        db.serialize(() => {
          db.run('CREATE TABLE test (id INTEGER PRIMARY KEY, val TEXT)')
          db.run('INSERT INTO test VALUES (?, ?)', [1, 'hello'])
          db.run('INSERT INTO test VALUES (?, ?)', [2, 'world'])
          db.all('SELECT * FROM test ORDER BY id', (queryErr: Error | null, rows: any[]) => {
            if (queryErr)
              return reject(queryErr)
            db.close()
            resolve(rows)
          })
        })
      })
    })

    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({ id: 1, val: 'hello' })
    expect(result[1]).toEqual({ id: 2, val: 'world' })
  })

  it('supports prepared statements with parameter binding', async () => {
    const cursorRequire = createRequire(`${CURSOR_APP_PATH}package.json`)
    sqlite3 = cursorRequire('@vscode/sqlite3')

    const result = await new Promise<any>((resolve, reject) => {
      const db = new sqlite3.Database(tmpDbPath)
      db.serialize(() => {
        db.run('CREATE TABLE t (k TEXT PRIMARY KEY, v TEXT)')
        const stmt = db.prepare('INSERT INTO t VALUES (?, ?)')
        stmt.run('foo', 'bar')
        stmt.run('baz', 'qux')
        stmt.finalize()

        db.get('SELECT v FROM t WHERE k = ?', ['foo'], (err: Error | null, row: any) => {
          if (err)
            return reject(err)
          db.close()
          resolve(row)
        })
      })
    })

    expect(result).toEqual({ v: 'bar' })
  })

  // ─── 3. WAL 模式验证 ───

  it('supports WAL journal mode', async () => {
    const cursorRequire = createRequire(`${CURSOR_APP_PATH}package.json`)
    sqlite3 = cursorRequire('@vscode/sqlite3')

    const result = await new Promise<any>((resolve, reject) => {
      const db = new sqlite3.Database(tmpDbPath, (err: Error | null) => {
        if (err)
          return reject(err)
        db.serialize(() => {
          db.run('PRAGMA journal_mode = WAL')
          db.get('PRAGMA journal_mode', (queryErr: Error | null, row: any) => {
            if (queryErr)
              return reject(queryErr)
            db.close()
            resolve(row)
          })
        })
      })
    })

    expect(result.journal_mode).toBe('wal')
  })

  it('supports busy_timeout pragma', async () => {
    const cursorRequire = createRequire(`${CURSOR_APP_PATH}package.json`)
    sqlite3 = cursorRequire('@vscode/sqlite3')

    const result = await new Promise<any>((resolve, reject) => {
      const db = new sqlite3.Database(tmpDbPath, (err: Error | null) => {
        if (err)
          return reject(err)
        db.serialize(() => {
          db.run('PRAGMA busy_timeout = 5000')
          db.get('PRAGMA busy_timeout', (queryErr: Error | null, row: any) => {
            if (queryErr)
              return reject(queryErr)
            db.close()
            resolve(row)
          })
        })
      })
    })

    expect(result.timeout).toBe(5000)
  })

  // ─── 4. 跨进程并发 ───

  it('handles concurrent connections to same DB (WAL mode)', async () => {
    const cursorRequire = createRequire(`${CURSOR_APP_PATH}package.json`)
    sqlite3 = cursorRequire('@vscode/sqlite3')

    // 1. 第一个连接初始化 + WAL
    await new Promise<void>((resolve, reject) => {
      const db = new sqlite3.Database(tmpDbPath, (err: Error | null) => {
        if (err)
          return reject(err)
        db.serialize(() => {
          db.run('PRAGMA journal_mode = WAL')
          db.run('CREATE TABLE t (id INTEGER, val TEXT)')
          db.run('INSERT INTO t VALUES (1, \'first\')', () => {
            db.close((closeErr: Error | null) => closeErr ? reject(closeErr) : resolve())
          })
        })
      })
    })

    // 2. 同时开两个连接读写
    const writeResult = new Promise<void>((resolve, reject) => {
      const db = new sqlite3.Database(tmpDbPath)
      db.serialize(() => {
        db.run('INSERT INTO t VALUES (2, \'second\')', (err: Error | null) => {
          if (err)
            return reject(err)
          db.close((closeErr: Error | null) => closeErr ? reject(closeErr) : resolve())
        })
      })
    })

    const readResult = new Promise<any[]>((resolve, reject) => {
      const db = new sqlite3.Database(tmpDbPath)
      db.all('SELECT * FROM t ORDER BY id', (err: Error | null, rows: any[]) => {
        if (err)
          return reject(err)
        db.close((closeErr: Error | null) => closeErr ? reject(closeErr) : resolve(rows))
      })
    })

    await Promise.all([writeResult, readResult])

    // 3. 验证两次写入都成功
    const finalRows = await new Promise<any[]>((resolve, reject) => {
      const db = new sqlite3.Database(tmpDbPath)
      db.all('SELECT * FROM t ORDER BY id', (err: Error | null, rows: any[]) => {
        if (err)
          return reject(err)
        db.close()
        resolve(rows)
      })
    })

    expect(finalRows.length).toBeGreaterThanOrEqual(2)
    expect(finalRows.find(r => r.id === 1)?.val).toBe('first')
    expect(finalRows.find(r => r.id === 2)?.val).toBe('second')
  })

  // ─── 5. 资源清理 ───

  it('properly closes and releases file handles', async () => {
    const cursorRequire = createRequire(`${CURSOR_APP_PATH}package.json`)
    sqlite3 = cursorRequire('@vscode/sqlite3')

    // 创建 → 关闭 → 再次打开 → 验证可用
    await new Promise<void>((resolve, reject) => {
      const db = new sqlite3.Database(tmpDbPath, (err: Error | null) => {
        if (err)
          return reject(err)
        db.run('CREATE TABLE t (x INTEGER)', (runErr: Error | null) => {
          if (runErr)
            return reject(runErr)
          db.close((closeErr: Error | null) => closeErr ? reject(closeErr) : resolve())
        })
      })
    })

    // 重新打开
    const reopened = await new Promise<boolean>((resolve, reject) => {
      const db = new sqlite3.Database(tmpDbPath, (err: Error | null) => {
        if (err)
          return reject(err)
        db.get('SELECT name FROM sqlite_master WHERE type=\'table\' AND name=\'t\'', (queryErr: Error | null, row: any) => {
          if (queryErr)
            return reject(queryErr)
          db.close()
          resolve(!!row)
        })
      })
    })

    expect(reopened).toBe(true)
  })

  // ─── 6. 错误处理 ───

  it('handles errors via callbacks (not exceptions)', async () => {
    const cursorRequire = createRequire(`${CURSOR_APP_PATH}package.json`)
    sqlite3 = cursorRequire('@vscode/sqlite3')

    const error = await new Promise<Error | null>((resolve) => {
      const db = new sqlite3.Database(tmpDbPath, (err: Error | null) => {
        if (err)
          return resolve(err)
        db.run('INVALID SQL', (runErr: Error | null) => {
          db.close()
          resolve(runErr)
        })
      })
    })

    expect(error).toBeTruthy()
    expect(error?.message).toMatch(/syntax error|near/i)
  })
})
