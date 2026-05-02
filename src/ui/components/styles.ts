/** Webview CSS — VS Code 主题变量适配 */
export const styles = /* css */ `
  * { box-sizing: border-box; }
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 0 12px 16px; margin: 0; }
  h3 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--vscode-sideBarSectionHeader-foreground); border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border); padding: 8px 0 4px; margin: 14px 0 6px; display: flex; align-items: center; justify-content: space-between; }
  h3 .h3-actions { display: flex; gap: 4px; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 4px 10px; border-radius: 2px; cursor: pointer; font-size: 11px; font-family: inherit; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button.danger { background: transparent; color: var(--vscode-errorForeground); padding: 2px 6px; }
  button.danger:hover { background: var(--vscode-inputValidation-errorBackground); }
  button.ghost { background: transparent; color: var(--vscode-foreground); padding: 2px 6px; opacity: 0.7; }
  button.ghost:hover { opacity: 1; background: var(--vscode-list-hoverBackground); }
  button.tiny { padding: 2px 6px; font-size: 10px; }
  input, select, textarea { width: 100%; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 3px 6px; font-size: 11px; border-radius: 2px; outline: none; font-family: var(--vscode-editor-font-family); resize: vertical; }
  input:focus, select:focus, textarea:focus { border-color: var(--vscode-focusBorder); }

  /* 移除 number input 的原生上下 spinner — 视觉冗余, 用户直接输入数字即可 */
  input[type=number] { -moz-appearance: textfield; }
  input[type=number]::-webkit-outer-spin-button,
  input[type=number]::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }

  /* CustomSelect — 完全 div 实现的下拉选择器 (原生 <select> 的展开 list 由浏览器接管无法样式化)
     trigger 的视觉与 <input> 完全一致, dropdown 自绘, 样式跟随 VS Code 主题 */
  .custom-select { position: relative; width: 100%; }
  .custom-select-trigger {
    display: flex;
    align-items: center;
    width: 100%;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border);
    padding: 3px 6px;
    font-size: 11px;
    border-radius: 2px;
    cursor: pointer;
    font-family: inherit;
    text-align: left;
  }
  .custom-select-trigger:hover { border-color: var(--vscode-focusBorder); }
  .custom-select-trigger:focus { outline: none; border-color: var(--vscode-focusBorder); }
  .custom-select-label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .custom-select-caret { opacity: 0.6; font-size: 8px; margin-left: 6px; }
  .custom-select-dropdown {
    position: absolute;
    top: calc(100% + 2px);
    left: 0;
    right: 0;
    z-index: 50;
    background: var(--vscode-quickInput-background, var(--vscode-editorWidget-background));
    border: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border));
    border-radius: 2px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
    max-height: 240px;
    overflow-y: auto;
    padding: 2px 0;
  }
  .custom-select-option {
    padding: 4px 10px;
    font-size: 11px;
    cursor: pointer;
    color: var(--vscode-foreground);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .custom-select-option.hover,
  .custom-select-option:hover { background: var(--vscode-list-hoverBackground); }
  .custom-select-option.selected {
    background: var(--vscode-list-activeSelectionBackground);
    color: var(--vscode-list-activeSelectionForeground);
  }
  input.invalid, textarea.invalid { border-color: var(--vscode-inputValidation-errorBorder, var(--vscode-errorForeground)); }
  input::placeholder { color: var(--vscode-input-placeholderForeground); }
  label { display: block; font-size: 10px; opacity: 0.7; margin: 4px 0 1px; text-transform: uppercase; letter-spacing: 0.3px; }
  .row { display: flex; align-items: center; justify-content: space-between; padding: 3px 0; font-size: 12px; gap: 8px; }
  .byok-banner { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 12px; margin: 10px -12px 0; background: var(--vscode-editorWidget-background); border-bottom: 1px solid var(--vscode-editorWidget-border); }
  .byok-banner .byok-label { display: flex; flex-direction: column; }
  .byok-banner .byok-title { font-weight: 600; font-size: 12px; }
  .byok-banner .byok-hint { font-size: 10px; opacity: 0.65; margin-top: 2px; }
  .byok-banner button.on { background: var(--vscode-statusBarItem-prominentBackground, #3794ff); color: var(--vscode-statusBarItem-prominentForeground, #fff); }
  .byok-banner button.off { background: var(--vscode-statusBarItem-warningBackground, #cc6633); color: var(--vscode-statusBarItem-warningForeground, #fff); }
  .server-row { display: flex; align-items: center; justify-content: space-between; padding: 4px 0; font-size: 12px; }

  .acc { border: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border)); border-radius: 3px; margin-bottom: 6px; background: var(--vscode-editor-background); }
  .acc.dirty { border-color: var(--vscode-inputValidation-warningBorder, #cca700); }
  .acc-head { display: flex; align-items: center; gap: 6px; padding: 6px 8px; cursor: pointer; user-select: none; }
  .acc-head:hover { background: var(--vscode-list-hoverBackground); }
  .acc-caret { font-size: 9px; opacity: 0.7; width: 10px; display: inline-block; }
  .acc-title { flex: 1; font-size: 12px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .acc-type { font-size: 9px; text-transform: uppercase; padding: 1px 5px; border-radius: 2px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); letter-spacing: 0.3px; }
  .acc-meta { font-size: 10px; opacity: 0.6; }
  .acc-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--vscode-inputValidation-warningBorder, #cca700); display: inline-block; }
  .acc-body { padding: 8px 10px 10px; border-top: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border)); }
  .field { margin-bottom: 4px; }
  .field-row { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .err { color: var(--vscode-errorForeground); font-size: 10px; margin-top: 2px; }

  .autocomplete { position: relative; }
  .autocomplete-list { position: absolute; top: 100%; left: 0; right: 0; z-index: 20; background: var(--vscode-quickInput-background, var(--vscode-editorWidget-background)); border: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border)); box-shadow: 0 2px 8px rgba(0,0,0,0.2); max-height: 200px; overflow-y: auto; margin-top: 1px; }
  .autocomplete-item { padding: 4px 8px; cursor: pointer; font-size: 11px; border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border)); }
  .autocomplete-item:last-child { border-bottom: none; }
  .autocomplete-item:hover, .autocomplete-item.selected { background: var(--vscode-list-hoverBackground); }
  .autocomplete-item .ac-name { font-weight: 500; }
  .autocomplete-item .ac-id { font-family: var(--vscode-editor-font-family); font-size: 10px; opacity: 0.65; margin-top: 1px; }
  .autocomplete-item .ac-meta { font-size: 10px; opacity: 0.55; margin-top: 1px; }
  .models-section { margin-top: 10px; padding-top: 8px; border-top: 1px dashed var(--vscode-widget-border, var(--vscode-editorWidget-border)); }
  .models-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px; }
  .models-title { font-size: 10px; text-transform: uppercase; letter-spacing: 0.3px; opacity: 0.7; }
  .model-item { border: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border)); border-radius: 2px; margin-bottom: 4px; background: var(--vscode-editorWidget-background); }
  .model-head { display: flex; align-items: center; gap: 6px; padding: 4px 6px; cursor: pointer; user-select: none; font-size: 11px; }
  .model-head:hover { background: var(--vscode-list-hoverBackground); }
  .model-body { padding: 6px 8px 8px; border-top: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border)); }
  .model-title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .model-empty { font-size: 10px; opacity: 0.5; font-style: italic; padding: 4px 0; }

  /* 模型标题栏右侧 defaultOn 开关 — iOS 风格 toggle switch
     尺寸 32x18, knob 12x12, track 边框 1px 计入外框。
     几何: 容器 32x18, knob (32-12)/2=10 剩余水平空间, knob 水平居中时 top=(18-12)/2=3
     off 位: left=3      (3 + 12 + border=1 = 16, 离右边 16)
     on  位: left=3+16=19 (翻译 16px, 离右边 1px)
     用显式 track + knob 子元素, 避免 ::before 伪元素渲染差异 */
  .model-switch {
    position: relative;
    display: inline-block;
    width: 32px;
    height: 18px;
    flex: 0 0 32px;
    cursor: pointer;
    vertical-align: middle;
    /* 覆盖全局 label { opacity: 0.7 } — 那是给字段标签 (uppercase 灰字) 用的,
       作为 <label> 的 switch 必须显式还原不透明才能显示本色 */
    opacity: 1;
    /* 也重置 label 的其他全局样式 */
    text-transform: none;
    letter-spacing: normal;
    margin: 0;
  }
  .model-switch input {
    position: absolute;
    inset: 0;
    opacity: 0;
    margin: 0;
    cursor: pointer;
    z-index: 3;
  }
  .model-switch-track {
    position: absolute;
    inset: 0;
    background: var(--vscode-input-background, #3c3c3c);
    border: 1px solid var(--vscode-input-border, #6c6c6c);
    border-radius: 9px;
    transition: background-color 0.15s ease, border-color 0.15s ease;
    z-index: 1;
    pointer-events: none;
    box-sizing: border-box;
  }
  .model-switch-knob {
    position: absolute;
    left: 3px;
    top: 3px;
    width: 12px;
    height: 12px;
    background: #cccccc;
    border-radius: 50%;
    transition: transform 0.2s ease, background-color 0.15s ease;
    z-index: 2;
    pointer-events: none;
    box-sizing: border-box;
  }
  .model-switch input:checked ~ .model-switch-track {
    background: var(--vscode-button-background, #d97757);
    border-color: var(--vscode-button-background, #d97757);
  }
  .model-switch input:checked ~ .model-switch-knob {
    transform: translateX(14px);
    background: #ffffff;
  }
  .model-switch:hover .model-switch-track { border-color: var(--vscode-focusBorder, #007fd4); }

  .actions-bar { display: flex; gap: 6px; justify-content: flex-end; margin-top: 10px; padding-top: 8px; border-top: 1px dashed var(--vscode-widget-border, var(--vscode-editorWidget-border)); }
  .empty { font-size: 11px; opacity: 0.6; padding: 12px 0; text-align: center; }
  .check { display: flex; align-items: center; gap: 4px; font-size: 10px; margin: 0; white-space: nowrap; }
  .check input { width: auto; }
  .caps { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px 8px; margin: 6px 0 4px; padding: 6px 0; border-top: 1px dashed var(--vscode-widget-border, var(--vscode-editorWidget-border)); border-bottom: 1px dashed var(--vscode-widget-border, var(--vscode-editorWidget-border)); }
  .caps .thinking-cell { grid-column: 1 / 2; }
  .caps .thinking-sub-disabled { grid-column: 2 / 4; }
  .caps .thinking-level-cell { grid-column: 2 / 4; }
  .caps .thinking-level-cell .custom-select-trigger { height: 20px; padding: 0 6px; font-size: 10px; }
  .caps .thinking-mode-group { grid-column: 2 / 4; display: flex; align-items: center; gap: 4px; flex-wrap: nowrap; }
  .thinking-mode-tabs { display: flex; flex-shrink: 0; }
  .thinking-mode-tab { font-size: 9px; padding: 1px 6px; border: 1px solid var(--vscode-widget-border); background: transparent; color: var(--vscode-foreground); cursor: pointer; opacity: 0.5; min-width: auto; height: 20px; }
  .thinking-mode-tab:first-child { border-radius: 3px 0 0 3px; }
  .thinking-mode-tab:last-child { border-radius: 0 3px 3px 0; border-left: none; }
  .thinking-mode-tab.active { opacity: 1; background: var(--vscode-button-secondaryBackground, rgba(255,255,255,0.08)); font-weight: 600; }
  .thinking-mode-value { flex: 1; min-width: 0; }
  .thinking-mode-value .custom-select-trigger { height: 20px; padding: 0 6px; font-size: 10px; }
  .input-reveal { position: relative; display: flex; align-items: center; }
  .input-reveal input { padding-right: 28px; }
  .reveal-btn { position: absolute; right: 2px; top: 50%; transform: translateY(-50%); background: transparent; border: none; padding: 2px 4px; cursor: pointer; color: var(--vscode-foreground); opacity: 0.6; min-width: auto; }
  .reveal-btn:hover { opacity: 1; background: transparent; }
  .footer { margin-top: 14px; display: flex; gap: 4px; }
  [x-cloak] { display: none !important; }

  .models-header-actions { display: flex; gap: 4px; align-items: center; }
  .models-loading-overlay { position: absolute; inset: 0; z-index: 10; background: rgba(0,0,0,.55); display: flex; align-items: center; justify-content: center; border-radius: 4px; backdrop-filter: blur(2px); }
  .models-loading-spinner { font-size: 12px; opacity: .9; letter-spacing: .3px; }
  .remote-models-panel { margin: 6px 0; border: 1px solid var(--vscode-panel-border, rgba(255,255,255,.1)); border-radius: 4px; overflow: hidden; }
  .remote-models-header { display: flex; justify-content: space-between; align-items: center; padding: 4px 8px; background: var(--vscode-sideBar-background, rgba(255,255,255,.03)); }
  .remote-models-title { font-size: 11px; opacity: .7; }
  .remote-models-list { max-height: 200px; overflow-y: auto; }
  .remote-model-item { padding: 3px 8px; font-size: 12px; font-family: var(--vscode-editor-font-family, monospace); cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .remote-model-item:hover { background: var(--vscode-list-hoverBackground, rgba(255,255,255,.06)); }

  .toast-container { position: fixed; bottom: 12px; left: 12px; right: 12px; z-index: 999; display: flex; flex-direction: column; gap: 6px; pointer-events: none; }
  .toast { pointer-events: auto; padding: 8px 12px; border-radius: 4px; font-size: 12px; line-height: 1.4; cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,.3); }
  .toast-error { background: var(--vscode-inputValidation-errorBackground, #5a1d1d); border: 1px solid var(--vscode-inputValidation-errorBorder, #be1100); color: var(--vscode-errorForeground, #f48771); }
  .toast-warn { background: var(--vscode-inputValidation-warningBackground, #352a05); border: 1px solid var(--vscode-inputValidation-warningBorder, #9d8600); color: var(--vscode-foreground); }
  .toast-info { background: var(--vscode-inputValidation-infoBackground, #063b49); border: 1px solid var(--vscode-inputValidation-infoBorder, #007acc); color: var(--vscode-foreground); }
  .toast-enter { animation: toast-in .2s ease-out; }
  .toast-leave { animation: toast-out .15s ease-in; }
  @keyframes toast-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
  @keyframes toast-out { from { opacity: 1; } to { opacity: 0; transform: translateY(8px); } }
`
