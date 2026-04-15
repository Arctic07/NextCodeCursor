/**
 * CustomSelect — 完全自定义样式的下拉选择器, 替代浏览器原生 <select>
 *
 * 原生 <select> 的 <option> 展开面板由浏览器接管, 无法用 CSS 覆盖。
 * 这里用 div + Alpine.js 状态实现, 样式完全跟随 VS Code 主题变量。
 *
 * 特性:
 *   - 点击 trigger 展开/收起
 *   - 点击选项后关闭 + 触发 changeExpr
 *   - 点击外部自动关闭
 *   - ESC 关闭
 *   - 键盘上下键导航 + Enter 选中
 *
 * 用法:
 *   <CustomSelect
 *     valueExpr="$store.app.getDraft(p.id).type"
 *     changeExpr="$store.app.updateField(p.id, 'type', $value)"
 *     options={[
 *       { value: 'anthropic', label: 'anthropic' },
 *       { value: 'openai-chat', label: 'openai-chat' },
 *     ]}
 *   />
 *
 *   changeExpr 中的 $value 占位符会被替换为选中项的值字符串字面量 (带引号)。
 */

export interface CustomSelectOption {
  value: string
  label: string
}

export interface CustomSelectProps {
  /** Alpine 表达式读取当前值 */
  valueExpr: string
  /**
   * 选中时触发的 Alpine 表达式; $value 占位符替换为字面量值
   * e.g. "$store.app.updateField(p.id, 'type', $value)"
   */
  changeExpr: string
  options: CustomSelectOption[]
  placeholder?: string
  title?: string
}

export function CustomSelect({ valueExpr, changeExpr, options, placeholder, title }: CustomSelectProps) {
  // 构造"读当前值 → 查 label"的 Alpine 表达式 (不依赖 store 辅助方法, 表达式自包含)
  // 结果: 三元链 ${valueExpr}==='a'?'A':(${valueExpr}==='b'?'B':placeholder)
  const labelExpr = options.reduceRight(
    (acc, opt) => `(${valueExpr})===${JSON.stringify(opt.value)}?${JSON.stringify(opt.label)}:${acc}`,
    JSON.stringify(placeholder ?? ''),
  )

  return (
    <div
      class="custom-select"
      x-data="{ open: false, hover: -1 }"
      {...{ 'x-on:click.outside': 'open = false' }}
      {...(title ? { title } : {})}
    >
      <button
        type="button"
        class="custom-select-trigger"
        x-on:click="open = !open"
        {...{ 'x-on:keydown.escape.prevent': 'open = false' }}
      >
        <span class="custom-select-label" x-text={labelExpr}></span>
        <span class="custom-select-caret" x-text="open ? '▲' : '▼'"></span>
      </button>
      <div class="custom-select-dropdown" x-show="open" x-cloak>
        {options.map((opt, idx) => (
          <div
            class="custom-select-option"
            x-bind:class={`{ 'selected': (${valueExpr}) === ${JSON.stringify(opt.value)}, 'hover': hover === ${idx} }`}
            x-on:mouseenter={`hover = ${idx}`}
            x-on:click={`${changeExpr.replaceAll('$value', JSON.stringify(opt.value))}; open = false`}
          >
            {opt.label}
          </div>
        ))}
      </div>
    </div>
  )
}
