# Change Log

All notable changes to the Cursor++ BYOK extension are documented here.

Format follows [Keep a Changelog](http://keepachangelog.com/).

## [0.0.6]

### Fixed

- 修复云控情况下模型获取到空串的问题
  (`Model '' was not found in ~/.ccursor/providers.json`)

## [0.0.5]

### Added

- 追加 openai responses 接口类型提供商
- 追加 LLM 错误到客户端侧的错误类型包装,避免错误成为消息内容显示到对话流中,
  部分错误情况可重试继续

### Changed

- UI 简化,移除用户侧迷惑字段
- UI 优化,弃用浏览器默认组件
- V3 跟进:实施多 Variant 映射显示模型
- 热重载改进,Save 后能及时刷新模型列表
- 日志大幅详尽化,多实例显示各自的日志内容

### Fixed

- revert 行为修正:LLM 不再记得已被回滚的部分内容
- 子代理正确沿用主代理所使用的模型
- 通过对齐 Tool 定义,修正 Qwen 3.5 / Qwen 3.6 模型的
  DUMMY_TOOL_RESULT 持续性工具调用错误
- 大幅改进 GPT 模型的文件修改动作与 diff 显示
- 修复 BYOK Mode 关闭状态下不能正确登录 Cursor 的问题
