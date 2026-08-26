import { afterEach, describe, expect, it } from 'vitest'
import { getCloneLineage, registerCloneLineage, resetCloneRegistryForTests } from '../handlers/agent/cloneRegistry'

describe('cloneRegistry — Fork Chat 血缘登记', () => {
  afterEach(() => {
    resetCloneRegistryForTests()
  })

  it('register 后能按 newConversationId 查回血缘', () => {
    registerCloneLineage('new-conv', { sourceConversationId: 'src-conv', sourceRequestId: 'req-7' })
    expect(getCloneLineage('new-conv')).toEqual({ sourceConversationId: 'src-conv', sourceRequestId: 'req-7' })
  })

  it('未登记的对话返回 undefined', () => {
    expect(getCloneLineage('unknown')).toBeUndefined()
  })

  it('空 newConversationId 不写入(防御 NotifyConversationClone 缺字段)', () => {
    registerCloneLineage('', { sourceConversationId: 'src', sourceRequestId: 'r' })
    expect(getCloneLineage('')).toBeUndefined()
  })

  it('同 newConversationId 重复登记以最后一次为准', () => {
    registerCloneLineage('c1', { sourceConversationId: 'a', sourceRequestId: 'r1' })
    registerCloneLineage('c1', { sourceConversationId: 'b', sourceRequestId: 'r2' })
    expect(getCloneLineage('c1')).toEqual({ sourceConversationId: 'b', sourceRequestId: 'r2' })
  })
})
