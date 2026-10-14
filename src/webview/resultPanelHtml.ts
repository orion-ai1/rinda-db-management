import { randomBytes } from 'node:crypto';
import type { TableEditingView } from '../editing/types.js';
import type { TableOverview } from '../explorer/metadataRepository.js';
import type { QueryResult } from '../query/QueryService.js';
import { buildTableOverviewItems } from './tableOverviewPresentation.js';

export interface RenderOptions {
  title: string;
  page?: number;
  canGoBack?: boolean;
  canGoForward?: boolean;
  error?: string;
  sql?: string;
  tableOverview?: TableOverview;
  tableOverviewError?: string;
  editing?: TableEditingView;
}

export function buildHtml(result: QueryResult, options: RenderOptions): string {
  const nonce = randomBytes(16).toString('base64');
  const rowsJson = jsonForScript(result.rows);
  const columnsJson = jsonForScript(result.columns);
  const editingJson = jsonForScript(options.editing ?? null);
  const summary = result.affectedRows > 0
    ? `影响 ${result.affectedRows} 行 · ${result.durationMs} ms`
    : `${result.rowCount} 行 · ${result.durationMs} ms${result.truncated ? ' · 已达到显示上限' : ''}`;
  const overview = buildOverview(options.tableOverview, options.tableOverviewError, options.editing);
  const hasOverview = Boolean(options.tableOverview || options.tableOverviewError || options.editing);
  const content = options.error
    ? `<section class="state error-state" role="alert"><h2>查询失败</h2><p>${escapeHtml(options.error)}</p></section>`
    : result.columns.length > 0
      ? buildTable(result, options.editing, options.page, options.canGoBack, options.canGoForward)
      : `<section class="state success-state"><h2>执行完成</h2><p>${escapeHtml(summary)}</p></section>`;

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}' 'unsafe-inline'; script-src 'nonce-${nonce}';"><title>${escapeHtml(options.title)}</title>
<style nonce="${nonce}">
*,*::before,*::after{box-sizing:border-box}*:focus,*:focus-visible{outline:none}:root{color-scheme:light dark;--canvas:var(--vscode-editor-background);--surface:var(--vscode-sideBar-background);--surface-2:var(--vscode-editorWidget-background);--surface-hover:var(--vscode-list-hoverBackground);--brand:var(--vscode-button-background);--brand-hover:var(--vscode-button-hoverBackground);--brand-weak:var(--vscode-list-activeSelectionBackground);--on-brand:var(--vscode-button-foreground);--text:var(--vscode-foreground);--strong:var(--vscode-editor-foreground);--muted:var(--vscode-descriptionForeground);--disabled:var(--vscode-disabledForeground);--border:var(--vscode-panel-border);--focus:var(--vscode-focusBorder);--success:var(--vscode-testing-iconPassed,#4ec9b0);--warning:var(--vscode-editorWarning-foreground,#cca700);--danger:var(--vscode-errorForeground,#f14c4c);--danger-bg:var(--vscode-inputValidation-errorBackground,#5a1d1d);--font:var(--vscode-font-family);--mono:var(--vscode-editor-font-family);--shadow:0 4px 16px var(--vscode-widget-shadow);--gutter:10px}html,body{margin:0;min-height:100%;height:100%}body{display:flex;flex-direction:column;font:13px/1.45 var(--font);color:var(--text);background:var(--canvas);-webkit-font-smoothing:antialiased;overflow:hidden}h1,h2,h3,p{margin:0}h1{font-size:13px;line-height:1.3;font-weight:600;color:var(--strong)}h2{font-size:13px;line-height:1.4;font-weight:600;color:var(--strong)}h3{font-size:12px;font-weight:600;color:var(--strong)}button,input,textarea{font:inherit}*{scrollbar-width:thin;scrollbar-color:var(--disabled) var(--surface-2)}::-webkit-scrollbar{width:8px;height:8px}::-webkit-scrollbar-track{background:var(--surface-2)}::-webkit-scrollbar-thumb{background:var(--disabled);border:2px solid var(--surface-2);border-radius:4px}
button{padding:4px 8px;color:var(--text);background:var(--surface-2);border:1px solid var(--border);border-radius:4px;cursor:pointer;transition:background-color 140ms ease,color 140ms ease,border-color 140ms ease,box-shadow 140ms ease}button:focus-visible{box-shadow:0 0 0 2px var(--focus)}button:disabled{opacity:.4;cursor:not-allowed}
.icon{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;flex:0 0 auto;display:inline-block;vertical-align:middle}
.topbar{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;min-height:38px;padding:6px var(--gutter);background:var(--surface);border-bottom:1px solid var(--border);flex:0 0 auto}
.title-group{display:flex;align-items:center;gap:6px;min-width:0;flex:0 1 auto;height:26px}
.table-badge-mini{display:grid;place-items:center;width:20px;height:20px;border-radius:3px;background:var(--brand);color:var(--on-brand);flex:0 0 auto}
.title-group h1{font-size:12px;font-weight:600;color:var(--strong);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:220px}
.title-summary{color:var(--muted);font-size:11px;white-space:nowrap}
.compact-sql-bar{display:flex;align-items:flex-start;gap:4px;flex:1 1 320px;min-width:180px;max-width:860px;margin:0 4px}
.compact-sql-editor{flex:1;height:26px;min-height:26px;max-height:320px;min-width:140px;padding:3px 8px;font:12px/1.45 var(--mono);color:var(--text);background:var(--surface-2);border:1px solid var(--border);border-radius:3px;resize:both;white-space:pre-wrap;overflow:auto;caret-color:var(--brand)}
.compact-sql-editor:focus{border-color:var(--focus);box-shadow:0 0 0 1px var(--focus);background:var(--canvas)}
.compact-sql-editor::-webkit-resizer{border-style:solid;border-width:0 0 7px 7px;border-color:transparent transparent var(--muted) transparent}
.sql-run-btn{display:inline-flex;align-items:center;gap:4px;height:26px;padding:0 8px;font-size:11px;font-weight:500;color:var(--on-brand);background:var(--brand);border:1px solid var(--brand);border-radius:3px;cursor:pointer;white-space:nowrap;flex:0 0 auto;align-self:flex-start}
.sql-run-btn:hover:not(:disabled){background:var(--brand-hover)}
.sql-explain-btn{background:var(--surface-2);color:var(--text);border-color:var(--border)}
.sql-explain-btn:hover:not(:disabled){background:var(--surface-hover);color:var(--strong);border-color:var(--border)}
.explain-badge{display:inline-block;padding:1px 5px;border-radius:3px;font-size:10px;font-weight:600}
.explain-badge.danger{background:color-mix(in srgb,var(--danger) 20%,transparent);color:var(--danger);border:1px solid color-mix(in srgb,var(--danger) 40%,transparent)}
.explain-badge.warning{background:color-mix(in srgb,var(--warning) 20%,transparent);color:var(--warning);border:1px solid color-mix(in srgb,var(--warning) 40%,transparent)}
.explain-badge.info{background:color-mix(in srgb,var(--brand) 20%,transparent);color:var(--brand);border:1px solid color-mix(in srgb,var(--brand) 40%,transparent)}
.explain-badge.success{background:color-mix(in srgb,var(--success) 20%,transparent);color:var(--success);border:1px solid color-mix(in srgb,var(--success) 40%,transparent)}
.topbar-tools{display:flex;align-items:center;gap:6px;flex:0 0 auto;height:26px}
.topbar-btn{display:inline-flex;align-items:center;gap:4px;height:26px;padding:0 8px;font-size:11px;color:var(--text);background:var(--surface-2);border:1px solid var(--border);border-radius:3px;cursor:pointer;white-space:nowrap}
.topbar-btn:hover{background:var(--surface-hover);color:var(--strong);border-color:var(--border)}
.topbar-btn.active{background:var(--brand-weak);border-color:var(--brand);color:var(--strong)}
#status{font-size:11px;white-space:nowrap;color:var(--muted)}#status.error{color:var(--danger)}#status.success{color:var(--success)}
.search-widget{display:flex;align-items:center;gap:6px;height:34px;padding:0 var(--gutter);background:var(--surface-2);border-bottom:1px solid var(--border);flex:0 0 auto}
.search-widget[hidden],.search-widget.hidden{display:none!important}
.search-icon{display:grid;place-items:center;color:var(--muted);width:16px;height:16px}
.search-input{flex:1;max-width:320px;height:24px;padding:2px 8px;font:12px var(--font);color:var(--text);background:var(--canvas);border:1px solid var(--border);border-radius:3px}
.search-input:focus{border-color:var(--focus);box-shadow:0 0 0 1px var(--focus)}
.search-count{font-size:11px;color:var(--muted);white-space:nowrap;min-width:44px;text-align:center}
.search-btn{display:inline-grid;place-items:center;width:24px;height:24px;padding:0;background:transparent;border:1px solid transparent;border-radius:3px;color:var(--text);cursor:pointer}
.search-btn:hover{background:var(--surface-hover);border-color:var(--border)}
.search-toggle-btn{display:inline-grid;place-items:center;width:24px;height:24px;padding:0;font-size:11px;font-family:var(--mono);font-weight:600;background:transparent;border:1px solid var(--border);border-radius:3px;color:var(--muted);cursor:pointer}
.search-toggle-btn:hover{background:var(--surface-hover);color:var(--strong)}
.search-toggle-btn.active{background:var(--brand-weak);border-color:var(--brand);color:var(--strong)}
main{display:flex;flex-direction:column;flex:1 1 auto;min-height:0;padding:4px var(--gutter);gap:4px;overflow:hidden}
.workspace{display:grid;grid-template-columns:minmax(0,1fr) 280px;gap:8px;flex:1 1 auto;min-height:0;overflow:hidden}.workspace.no-overview{grid-template-columns:minmax(0,1fr)}.workspace.sidebar-collapsed{grid-template-columns:minmax(0,1fr) 0px}.workspace.sidebar-collapsed .overview-sidebar{display:none}
.table-area{display:flex;flex-direction:column;min-height:0;height:100%;background:var(--surface);border:1px solid var(--border);border-radius:4px;overflow:hidden}
.table-shell{flex:1 1 auto;min-height:140px;overflow:auto;background:var(--canvas)}table{width:max-content;min-width:100%;border-collapse:separate;border-spacing:0;font:12px/1.45 var(--mono);font-variant-numeric:tabular-nums}th,td{max-width:380px;padding:0;border-right:1px solid var(--border);border-bottom:1px solid var(--border);text-align:left;vertical-align:middle}th{position:sticky;z-index:50;top:0;padding:5px 8px;background:var(--surface-2);color:var(--strong);font-family:var(--font);font-weight:600;white-space:nowrap;user-select:none}th.grid-th{cursor:pointer;user-select:none;transition:background-color 120ms ease}th.grid-th:hover{background-color:var(--surface-hover)}.sort-badge{display:inline-block;margin-left:4px;font-size:10px;color:var(--brand);font-weight:bold;min-width:10px}th:last-child,td:last-child{border-right:0}tbody tr:last-child td{border-bottom:0}
.sticky-cell{position:sticky;left:0;z-index:25;background:var(--surface-2)}th.sticky-cell{z-index:75}.select-col{width:32px;min-width:32px;max-width:32px;text-align:center;padding:0}.status-col{width:26px;min-width:26px;max-width:26px;text-align:center;padding:0;left:32px}.row-state{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--disabled)}tr.has-draft .row-state{background:var(--warning);box-shadow:0 0 0 2px color-mix(in srgb,var(--warning) 25%,transparent)}
tbody tr:hover td,tbody tr:hover td.sticky-cell{background-color:var(--surface-hover)}
tbody tr.selected td,tbody tr.selected td.sticky-cell{background-color:color-mix(in srgb,var(--brand-weak) 38%,var(--canvas))}
tbody tr.active-row td,tbody tr.active-row td.sticky-cell{background-color:var(--brand-weak);color:var(--vscode-list-activeSelectionForeground,var(--text))}
tbody tr.active-row .null{color:color-mix(in srgb,var(--vscode-list-activeSelectionForeground,#fff) 60%,transparent)}
tbody tr.new-row td,tbody tr.new-row td.sticky-cell{background-color:color-mix(in srgb,var(--brand) 8%,var(--canvas))}
tbody tr.new-row .new-row-state{display:inline-block;width:14px;height:14px;line-height:14px;text-align:center;font-size:11px;color:var(--brand);font-weight:bold;background:transparent}
tbody tr.new-row td.cell.autoincrement .cell-value{color:var(--muted);font-style:italic}
.col-head-box{display:flex;flex-direction:column;gap:2px}.col-head-name{display:inline-flex;align-items:center;font-weight:600;color:var(--strong);font-size:12px}.col-type-badge{display:inline-flex;align-items:center;gap:3px;font-size:10px;color:var(--muted);font-family:var(--mono);font-weight:400}.type-icon{font-size:9px;padding:0 3px;background:var(--surface);border:1px solid var(--border);border-radius:2px;font-weight:600}
.check{display:inline-grid;place-items:center;margin:0;cursor:pointer}.check input{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none}.check-box{display:grid;place-items:center;width:15px;height:15px;color:var(--on-brand);background:var(--surface-2);border:1px solid var(--border);border-radius:3px;transition:background-color 140ms ease,border-color 140ms ease}.check input:checked+.check-box{background:var(--brand);border-color:var(--brand)}.check .icon{width:11px;height:11px;opacity:0}.check input:checked+.check-box .icon{opacity:1}
.cell{position:relative;min-width:120px;height:36px;padding:4px 8px;cursor:default;border-radius:0;transition:background-color 140ms ease,box-shadow 140ms ease;user-select:none}.cell:focus,.cell:focus-visible{outline:none!important}.cell.active{position:relative;box-shadow:inset 0 0 0 1.5px var(--focus)!important;background-color:color-mix(in srgb,var(--focus) 20%,var(--brand-weak))!important;padding-right:28px!important}.cell.editing{padding:0!important;box-shadow:none!important}.cell.editable{cursor:text}.cell.draft{background:color-mix(in srgb,var(--warning) 12%,var(--canvas))!important;position:relative}.cell.draft::after{content:'';position:absolute;top:0;right:0;width:0;height:0;border-style:solid;border-width:0 6px 6px 0;border-color:transparent var(--warning) transparent transparent}.cell-value{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;max-height:2.9em;overflow:hidden;text-overflow:ellipsis;white-space:pre-wrap;overflow-wrap:anywhere}.null{color:var(--disabled);font-style:italic}
.cell-detail-btn{position:absolute;right:3px;top:50%;transform:translateY(-50%);display:inline-grid;place-items:center;width:20px;height:20px;padding:0;color:var(--text);background:var(--surface-2);border:1px solid var(--border);border-radius:3px;cursor:pointer;z-index:5;box-shadow:0 1px 3px rgba(0,0,0,0.25);transition:background-color 120ms ease,color 120ms ease,border-color 120ms ease}
.cell-detail-btn:hover{background:var(--brand);color:var(--on-brand);border-color:var(--brand)}
.cell-detail-icon{width:12px;height:12px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.cell.search-match{background:color-mix(in srgb,#cca700 22%,var(--canvas))!important}
.cell.search-match-active{background:color-mix(in srgb,#cca700 45%,var(--canvas))!important;box-shadow:inset 0 0 0 2px #cca700!important}
.inline-editor{display:block;width:100%;height:100%;min-height:34px;padding:4px 7px;margin:0;resize:none;color:var(--text);background:var(--canvas);border:1.5px solid var(--focus);outline:none;border-radius:0;font:12px/1.4 var(--mono);box-sizing:border-box;user-select:text}
.table-context-menu{position:fixed;z-index:1000;min-width:180px;padding:4px 0;background:var(--surface);border:1px solid var(--border);border-radius:5px;box-shadow:0 4px 16px rgba(0,0,0,0.35);font-size:12px;user-select:none}
.table-context-menu[hidden]{display:none!important}
.menu-group{display:flex;flex-direction:column}
.menu-item{display:flex;align-items:center;gap:8px;width:100%;padding:6px 12px;border:none;background:transparent;color:var(--text);font-size:12px;text-align:left;cursor:pointer;transition:background-color 100ms ease}
.menu-item:hover:not(:disabled){background:var(--brand);color:var(--on-brand)}
.menu-item:hover:not(:disabled) svg{color:var(--on-brand)}
.menu-item:disabled{opacity:.4;cursor:not-allowed}
.menu-item.danger:hover:not(:disabled){background:var(--danger);color:#fff}
.menu-item svg{width:13px;height:13px;opacity:.75}
.menu-divider{height:1px;margin:4px 0;background:var(--border)}
.detail-panel{display:flex;flex-direction:column;flex:0 0 auto;height:140px;min-height:110px;max-height:220px;background:var(--surface);border-top:1px solid var(--border)}
.detail-panel.collapsed{display:none!important}
.detail-tabs{display:flex;align-items:center;gap:2px;height:28px;padding:0 8px;background:var(--surface-2);border-bottom:1px solid var(--border)}.detail-tab{padding:2px 10px;height:22px;font-size:11px;color:var(--muted);background:transparent;border:1px solid transparent;border-radius:3px;cursor:pointer}.detail-tab:hover{color:var(--strong);background:var(--surface-hover)}.detail-tab.active{color:var(--strong);background:var(--surface);border-color:var(--border);font-weight:600}.detail-col-info{margin-left:8px;font-size:11px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1}.detail-tab-tools{display:flex;align-items:center;gap:6px;margin-left:auto}.detail-tool-btn{padding:2px 8px;height:22px;font-size:11px;color:var(--text);background:var(--surface-2);border:1px solid var(--border);border-radius:3px}.detail-tool-btn[hidden],.detail-tool-btn.hidden{display:none!important}.null-switch{display:none}.null-switch.visible{display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 6px;font-size:11px;color:var(--muted);background:var(--surface-2);border:1px solid var(--border);border-radius:3px;cursor:pointer}.null-switch[hidden],.null-switch.hidden{display:none!important}.null-switch:hover:not(:disabled){background:var(--surface-hover);color:var(--strong)}.switch-track{position:relative;width:24px;height:13px;border-radius:8px;background:var(--disabled);transition:background-color 140ms ease}.switch-thumb{position:absolute;top:1px;left:1px;width:11px;height:11px;border-radius:50%;background:#fff;transition:transform 140ms ease}.null-switch[aria-checked="true"] .switch-track{background:var(--brand)}.null-switch[aria-checked="true"] .switch-thumb{transform:translateX(11px)}
.detail-editor-container{display:flex;flex:1 1 auto;min-height:0;position:relative;background:var(--canvas);overflow:hidden}.tab-pane{display:none!important;width:100%;height:100%;min-height:0}.tab-pane.active{display:flex!important}.editor-gutter,.json-gutter{padding:6px 6px;background:var(--surface-2);border-right:1px solid var(--border);color:var(--disabled);font:11px/1.5 var(--mono);user-select:none;text-align:right;min-width:24px;overflow:hidden}.editor-gutter .line-number,.json-gutter .line-number{display:block}.detail-editor{flex:1;padding:6px 8px;border:none;background:transparent;color:var(--text);font:12px/1.5 var(--mono);resize:none;outline:none;overflow:auto;caret-color:var(--brand);user-select:text}.empty-tab-hint{display:grid;place-content:center;width:100%;color:var(--disabled);font-size:11px}.field-error{padding:2px 8px;color:var(--danger);font-size:11px;background:var(--surface);border-top:1px solid var(--border);min-height:18px;display:none}.field-error:not(:empty){display:block}
.navicat-bottom-bar{display:flex;align-items:center;justify-content:space-between;gap:10px;height:36px;min-height:36px;padding:0 8px;background:var(--surface-2);border-top:1px solid var(--border);flex:0 0 auto}.navicat-actions{display:flex;align-items:center;gap:3px;min-width:0;flex:1 1 auto}.navicat-btn{display:inline-grid;place-items:center;width:28px;height:28px;padding:0;color:var(--text);background:transparent;border:1px solid transparent;border-radius:3px;cursor:pointer}.navicat-btn:hover:not(:disabled){background:var(--surface-hover);border-color:var(--border)}.navicat-btn:disabled{opacity:.35;cursor:not-allowed}.navicat-btn.btn-commit{color:var(--success)}.navicat-btn.btn-commit.has-drafts{background:var(--success);color:var(--on-brand);border-color:var(--success);box-shadow:0 0 0 2px color-mix(in srgb,var(--success) 35%,transparent)}.navicat-btn.btn-commit.has-drafts:hover{filter:brightness(1.15)}.navicat-btn.btn-discard{color:var(--muted)}.navicat-btn.btn-discard.has-drafts{color:var(--danger)}.bar-divider{width:1px;height:16px;margin:0 4px;background:var(--border)}.navicat-text-btn{display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 6px;font-size:11px;color:var(--muted);background:transparent;border:1px solid transparent;border-radius:3px}.navicat-text-btn:hover:not(:disabled){color:var(--strong);background:var(--surface-hover);border-color:var(--border)}.navicat-text-btn.active{color:var(--strong);background:var(--brand-weak);border-color:var(--brand)}.navicat-status-text{margin-left:6px;font-size:11px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.navicat-status-text.limit-error{color:var(--danger);font-weight:600}.navicat-pagination{display:flex;align-items:center;gap:3px;flex:0 0 auto}.navicat-page-label{padding:0 4px;font-size:11px;color:var(--muted);white-space:nowrap}
.overview-sidebar{display:flex;flex-direction:column;min-height:0;height:100%;background:var(--surface);border:1px solid var(--border);border-radius:4px;overflow:hidden}.overview-header{padding:10px;border-bottom:1px solid var(--border);background:var(--surface-2)}.overview-title-row{display:flex;align-items:center;gap:8px}.table-badge-icon{display:grid;place-items:center;width:24px;height:24px;border-radius:4px;background:var(--brand);color:var(--on-brand);flex:0 0 auto}.overview-title-info{min-width:0;flex:1 1 auto}.overview-table-name{font-size:13px;font-weight:600;color:var(--strong);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.overview-object-tag{font-size:10px;padding:1px 4px;border-radius:2px;background:var(--surface-hover);color:var(--muted)}.overview-close-btn{padding:2px 4px;height:22px;border:none;background:transparent;color:var(--muted)}.overview-close-btn:hover{color:var(--strong)}.overview-body{flex:1 1 auto;overflow:auto;padding:10px;display:flex;flex-direction:column;gap:8px}.overview-note{color:var(--muted);font-size:11px}.overview-grid{display:grid;gap:6px;margin:0}.overview-item{padding:5px 8px;background:var(--surface-2);border-radius:3px;display:flex;flex-direction:column;gap:2px}.overview-item dt{color:var(--muted);font-size:10px}.overview-item dd{margin:0;color:var(--strong);font:11px/1.4 var(--mono);overflow-wrap:anywhere}.overview-error{padding:6px;color:var(--warning);background:var(--surface-2);border-radius:3px;font-size:11px}
.overlay{position:fixed;z-index:300;inset:0;display:grid;place-items:center;padding:16px;background:color-mix(in srgb,var(--canvas) 75%,transparent);opacity:0;visibility:hidden;pointer-events:none;transition:opacity 140ms ease,visibility 0s linear 140ms}.overlay.open{opacity:1;visibility:visible;pointer-events:auto;transition-delay:0s}.dialog{display:grid;gap:10px;width:min(520px,100%);padding:14px;background:var(--surface);border:1px solid var(--focus);border-radius:6px;box-shadow:var(--shadow);transform:translateY(6px);transition:transform 140ms ease}.overlay.open .dialog{transform:translateY(0)}.dialog-copy{color:var(--muted);font-size:12px}.dialog-summary{padding:8px;background:var(--surface-2);border-radius:4px;font:11px/1.45 var(--mono);white-space:pre-wrap;max-height:160px;overflow:auto}.dialog-actions{display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap}.danger-btn{color:#fff;background:var(--danger);border-color:var(--danger)}.danger-btn:hover:not(:disabled){filter:brightness(1.1)}.commit{color:var(--on-brand);background:var(--success);border-color:var(--success)}.message{min-height:18px;font-size:11px;color:var(--muted)}.message.error{color:var(--danger)}.state{min-height:140px;padding:20px;display:grid;place-content:center;gap:6px;text-align:center;background:var(--surface);border-radius:4px}.state p{color:var(--muted)}
.delete-confirm-box{display:grid;gap:4px}.delete-confirm-label{font-size:11px;color:var(--muted)}.delete-confirm-input{width:100%;padding:5px 8px;font:12px var(--mono);background:var(--surface-2);border:1px solid var(--border);border-radius:4px;color:var(--text)}
@media(max-width:768px){.workspace{grid-template-columns:minmax(0,1fr)}.overview-sidebar{display:none}}
</style></head><body>
<header class="topbar">
  <div class="title-group">
    <div class="table-badge-mini" aria-hidden="true">${icon('table')}</div>
    <h1 title="${escapeHtml(options.title)}">${escapeHtml(options.title)}</h1>
    <span class="title-summary">${escapeHtml(summary)}</span>
  </div>
  ${options.sql ? `
  <div class="compact-sql-bar" role="search" aria-label="SQL 查询栏">
    <textarea id="sqlEditor" class="compact-sql-editor" rows="1" placeholder="输入 SQL (Enter 重新执行，可拖动右下角拉大)..." spellcheck="false" autocomplete="off" aria-label="编辑 SQL 并重新执行">${escapeHtml(options.sql.trim())}</textarea>
    <button id="executeSql" class="sql-run-btn" type="button" title="重新执行当前 SQL (Enter 或 Cmd/Ctrl+Enter)">${icon('play')} 执行</button>
    <button id="explainSql" class="sql-run-btn sql-explain-btn" type="button" title="分析执行计划 (EXPLAIN)">${icon('info')} EXPLAIN</button>
  </div>
  ` : ''}
  <div class="topbar-tools">
    <button id="searchBtn" class="topbar-btn" type="button" title="在当前页查找数据 (Cmd/Ctrl+F)">${icon('search')} 查找</button>
    ${hasOverview ? `<button id="toggleSidebarBtn" class="topbar-btn" type="button" title="折叠/展开源表概览">${icon('info')} 概览</button>` : ''}
    <span id="status" role="status" aria-live="polite"></span>
  </div>
</header>
<div id="searchWidget" class="search-widget" hidden>
  <div class="search-icon" aria-hidden="true">${icon('search')}</div>
  <input id="searchInput" class="search-input" type="text" placeholder="查找当前页数据 (Enter 下一个，Shift+Enter 上一个)..." autocomplete="off" spellcheck="false">
  <span id="searchCount" class="search-count">0 / 0</span>
  <button id="searchPrev" class="search-btn" type="button" title="上一个匹配项 (Shift+Enter)">${icon('chevron-up')}</button>
  <button id="searchNext" class="search-btn" type="button" title="下一个匹配项 (Enter)">${icon('chevron-down')}</button>
  <button id="searchCase" class="search-toggle-btn" type="button" title="区分大小写">Aa</button>
  <button id="searchClose" class="search-btn" type="button" title="关闭查找 (Esc)">${icon('x')}</button>
</div>
<main>
  <div class="workspace${hasOverview ? '' : ' no-overview'}">
    <section class="table-area">${content}</section>
    ${overview}
  </div>
</main>
<div id="commitOverlay" class="overlay" aria-hidden="true">
  <section class="dialog" role="dialog" aria-modal="true" aria-labelledby="commitTitle" tabindex="-1">
    <h2 id="commitTitle">确认原子提交更改</h2>
    <p class="dialog-copy">将先在事务中锁定并核对原始快照；任一行冲突或失败整批自动全量回滚。</p>
    <pre id="commitSummary" class="dialog-summary"></pre>
    <p id="commitMessage" class="message" role="status" aria-live="polite"></p>
    <div class="dialog-actions">
      <button id="cancelCommit" type="button">取消</button>
      <button id="confirmCommit" class="commit" type="button">确认提交全部草稿</button>
    </div>
  </section>
</div>
<div id="deleteOverlay" class="overlay" aria-hidden="true">
  <section class="dialog" role="dialog" aria-modal="true" aria-labelledby="deleteTitle" tabindex="-1">
    <h2 id="deleteTitle">确认安全删除该行</h2>
    <p class="dialog-copy">将按确定性定位键在事务中核对原始快照并执行精确删除。此操作无法撤销。</p>
    <pre id="deleteSummary" class="dialog-summary"></pre>
    <div class="delete-confirm-box">
      <label for="deleteConfirmationInput" class="delete-confirm-label">请输入 <strong>DELETE</strong> 确认：</label>
      <input id="deleteConfirmationInput" type="text" class="delete-confirm-input" placeholder="DELETE" autocomplete="off">
    </div>
    <p id="deleteMessage" class="message" role="status" aria-live="polite"></p>
    <div class="dialog-actions">
      <button id="cancelDelete" type="button">取消</button>
      <button id="confirmDelete" class="danger-btn" type="button" disabled>确认删除</button>
    </div>
  </section>
</div>
<div id="leaveOverlay" class="overlay" aria-hidden="true">
  <section class="dialog" role="dialog" aria-modal="true" aria-labelledby="leaveTitle" tabindex="-1">
    <h2 id="leaveTitle">有尚未提交的草稿</h2>
    <p class="dialog-copy">离开会使当前页的行 token 与快照失效。请选择提交、放弃或继续留在当前页。</p>
    <div class="dialog-actions">
      <button id="cancelLeave" type="button">取消</button>
      <button id="discardLeave" type="button">放弃并继续</button>
      <button id="saveLeave" class="commit" type="button">提交后继续</button>
    </div>
  </section>
</div>
<div id="tableContextMenu" class="table-context-menu" hidden>
  <div class="menu-group">
    <button type="button" class="menu-item" data-action="copyCell">${icon('copy')} <span>复制单元格值</span></button>
    <button type="button" class="menu-item" data-action="setNull"><span>设置为 NULL</span></button>
    <button type="button" class="menu-item" data-action="setEmpty"><span>设置为空白字符串</span></button>
    <button type="button" class="menu-item" data-action="openDetail"><span>在详情面板中编辑</span></button>
  </div>
  <div class="menu-divider"></div>
  <div class="menu-group">
    <button type="button" class="menu-item" data-action="copyRows">${icon('copy')} <span id="ctxCopyRowsLabel">复制选中行记录</span></button>
    <button type="button" class="menu-item" data-action="copyInsert"><span>复制为 INSERT 语句</span></button>
    <button type="button" class="menu-item danger" data-action="deleteRows">${icon('minus')} <span id="ctxDeleteRowsLabel">删除选中行</span></button>
  </div>
  <div class="menu-divider"></div>
  <div class="menu-group">
    <button type="button" class="menu-item" data-action="selectAll"><span>全选所有行</span></button>
    <button type="button" class="menu-item" data-action="clearSelection"><span>取消选择</span></button>
  </div>
</div>
<script nonce="${nonce}">
const vscode=acquireVsCodeApi();
const tableRows=${rowsJson};
const tableColumns=${columnsJson};
const tableEditing=${editingJson};
const drafts=new Map();
const selectedRows=new Set();
let activeCell=null,inline=null,saving=false,pendingAction=null,submitThenContinue=false,activeTab='text';
let hasNewRow=false,newRowValues={};
let detailCollapsed=Boolean(vscode.getState?.()?.detailCollapsed??true);
let searchOpen=false,searchMatches=[],searchIndex=-1,searchCaseSensitive=false;
const status=document.getElementById('status'),detailPanel=document.getElementById('detailPanel'),detailEditor=document.getElementById('detailEditor'),detailMeta=document.getElementById('detailMeta'),detailError=document.getElementById('detailError'),nullSwitch=document.getElementById('detailNull'),formatJsonBtn=document.getElementById('formatJsonBtn');
const toggleDetailBtn=document.getElementById('toggleDetailBtn'),bottomToggleDetailBtn=document.getElementById('bottomToggleDetailBtn');
const searchWidget=document.getElementById('searchWidget'),searchBtn=document.getElementById('searchBtn'),searchInput=document.getElementById('searchInput'),searchCount=document.getElementById('searchCount'),searchPrev=document.getElementById('searchPrev'),searchNext=document.getElementById('searchNext'),searchCase=document.getElementById('searchCase'),searchClose=document.getElementById('searchClose');
const isNewRow=r=>Boolean(hasNewRow&&r===tableRows.length);
const key=(r,c)=>r+':'+c,columnView=c=>tableEditing?.columns?.[c],rowView=r=>tableEditing?.rows?.[r];
const current=(r,c)=>{
  if(isNewRow(r))return newRowValues[tableColumns[c]]??null;
  return drafts.has(key(r,c))?drafts.get(key(r,c)):tableRows[r]?.[c]??null;
};
const editable=(r,c)=>{
  if(isNewRow(r)){
    const col=columnView(c);
    return Boolean(tableEditing?.enabled&&col&&!col.autoIncrement&&!['blob','geometry','point','linestring','polygon'].includes((col.dataType||'').toLowerCase()));
  }
  return Boolean(tableEditing?.enabled&&rowView(r)?.token&&columnView(c)?.editable);
};
const setStatus=(text,kind='')=>{if(status){status.textContent=text;status.className=kind?kind:''}};
const operationId=()=>globalThis.crypto?.randomUUID?.().replaceAll('-','')??(Date.now().toString(36)+'_'+Math.random().toString(36).slice(2));
const persist=()=>{vscode.setState?.({sessionId:tableEditing?.sessionId,drafts:[...drafts],selected:[...selectedRows],active:activeCell,detailCollapsed});vscode.postMessage({type:'dirtyState',dirty:drafts.size>0||hasNewRow})};

const setDetailCollapsed=(collapsed)=>{
  detailCollapsed=collapsed;
  if(detailPanel)detailPanel.classList.toggle('collapsed',collapsed);
  if(toggleDetailBtn)toggleDetailBtn.innerHTML=collapsed?'展开 ▴':'收起 ▾';
  if(bottomToggleDetailBtn){
    bottomToggleDetailBtn.innerHTML=collapsed?'展开详情 ▴':'收起详情 ▾';
    bottomToggleDetailBtn.classList.toggle('active',!collapsed);
  }
  persist();
};
toggleDetailBtn?.addEventListener('click',()=>setDetailCollapsed(!detailCollapsed));
bottomToggleDetailBtn?.addEventListener('click',()=>setDetailCollapsed(!detailCollapsed));

const clearSearchHighlights=()=>{
  document.querySelectorAll('td.cell.search-match,td.cell.search-match-active').forEach(c=>{
    c.classList.remove('search-match','search-match-active');
  });
};
const updateSearchCount=()=>{
  if(!searchCount)return;
  if(!searchMatches.length){
    searchCount.textContent=searchInput?.value.trim()?'0 / 0':'';
  }else{
    searchCount.textContent=(searchIndex+1)+' / '+searchMatches.length;
  }
};
const highlightMatch=(index)=>{
  if(index<0||index>=searchMatches.length)return;
  document.querySelectorAll('td.cell.search-match-active').forEach(c=>c.classList.remove('search-match-active'));
  const m=searchMatches[index];
  const target=document.querySelector('td.cell[data-row="'+m.row+'"][data-column="'+m.col+'"]');
  if(target){
    target.classList.add('search-match-active');
    target.scrollIntoView({block:'nearest',inline:'nearest'});
  }
  updateSearchCount();
};
const runSearch=()=>{
  clearSearchHighlights();
  searchMatches=[];
  searchIndex=-1;
  const q=searchInput?.value??'';
  if(!q.trim()){updateSearchCount();return}
  const query=searchCaseSensitive?q:q.toLowerCase();
  for(let r=0;r<tableRows.length;r++){
    for(let c=0;c<tableColumns.length;c++){
      const val=String(current(r,c)??'');
      const str=searchCaseSensitive?val:val.toLowerCase();
      if(str.includes(query)){
        searchMatches.push({row:r,col:c});
        const cell=document.querySelector('td.cell[data-row="'+r+'"][data-column="'+c+'"]');
        if(cell)cell.classList.add('search-match');
      }
    }
  }
  if(searchMatches.length>0){
    searchIndex=0;
    highlightMatch(0);
  }else{
    updateSearchCount();
  }
};
const openSearch=()=>{
  searchOpen=true;
  if(searchWidget){searchWidget.hidden=false;searchWidget.classList.remove('hidden')}
  searchBtn?.classList.add('active');
  searchInput?.focus();
  searchInput?.select();
  runSearch();
};
const closeSearch=()=>{
  searchOpen=false;
  if(searchWidget){searchWidget.hidden=true;searchWidget.classList.add('hidden')}
  searchBtn?.classList.remove('active');
  clearSearchHighlights();
  searchMatches=[];
  searchIndex=-1;
  updateSearchCount();
};
searchBtn?.addEventListener('click',()=>{if(searchOpen)closeSearch();else openSearch()});
searchClose?.addEventListener('click',closeSearch);
searchInput?.addEventListener('input',runSearch);
searchInput?.addEventListener('keydown',event=>{
  if(event.key==='Escape'){event.preventDefault();closeSearch()}
  else if(event.key==='Enter'){
    event.preventDefault();
    if(!searchMatches.length)return;
    if(event.shiftKey){searchIndex=(searchIndex-1+searchMatches.length)%searchMatches.length}
    else{searchIndex=(searchIndex+1)%searchMatches.length}
    highlightMatch(searchIndex);
  }
});
searchNext?.addEventListener('click',()=>{if(searchMatches.length){searchIndex=(searchIndex+1)%searchMatches.length;highlightMatch(searchIndex)}});
searchPrev?.addEventListener('click',()=>{if(searchMatches.length){searchIndex=(searchIndex-1+searchMatches.length)%searchMatches.length;highlightMatch(searchIndex)}});
searchCase?.addEventListener('click',()=>{
  searchCaseSensitive=!searchCaseSensitive;
  searchCase?.classList.toggle('active',searchCaseSensitive);
  runSearch();
});
document.addEventListener('keydown',event=>{
  if((event.metaKey||event.ctrlKey)&&(event.key==='f'||event.key==='F')){
    event.preventDefault();
    openSearch();
  }
});

const parsePhpSerialized=(str)=>{
  if(typeof str!=='string'||!str.length)return undefined;
  let pos=0;
  function parseVal(){
    if(pos>=str.length)return undefined;
    const type=str[pos];
    if(type==='N'&&str[pos+1]===';'){pos+=2;return null}
    if(str[pos+1]!==':')return undefined;
    pos+=2;
    if(type==='i'){
      const end=str.indexOf(';',pos);
      if(end===-1)return undefined;
      const val=parseInt(str.slice(pos,end),10);
      pos=end+1;
      return val;
    }
    if(type==='d'){
      const end=str.indexOf(';',pos);
      if(end===-1)return undefined;
      const val=parseFloat(str.slice(pos,end));
      pos=end+1;
      return val;
    }
    if(type==='b'){
      const end=str.indexOf(';',pos);
      if(end===-1)return undefined;
      const val=str.slice(pos,end)==='1';
      pos=end+1;
      return val;
    }
    if(type==='s'){
      const colon=str.indexOf(':',pos);
      if(colon===-1)return undefined;
      const len=parseInt(str.slice(pos,colon),10);
      const quoteStart=colon+1;
      if(str[quoteStart]!=='"')return undefined;
      const strStart=quoteStart+1;
      const val=str.substr(strStart,len);
      pos=strStart+len+2;
      return val;
    }
    if(type==='a'){
      const colon=str.indexOf(':',pos);
      if(colon===-1)return undefined;
      const count=parseInt(str.slice(pos,colon),10);
      if(str[colon+1]!=='{')return undefined;
      pos=colon+2;
      const obj={};
      let isArr=true;
      for(let i=0;i<count;i++){
        const k=parseVal();
        const v=parseVal();
        if(k===undefined||v===undefined)return undefined;
        if(k!==i)isArr=false;
        obj[k]=v;
      }
      if(str[pos]==='}')pos+=1;
      if(str[pos]===';')pos+=1;
      return isArr?Object.values(obj):obj;
    }
    if(type==='O'){
      const colon=str.indexOf(':',pos);
      if(colon===-1)return undefined;
      const clsLen=parseInt(str.slice(pos,colon),10);
      const clsNameStart=colon+2;
      const clsName=str.substr(clsNameStart,clsLen);
      pos=clsNameStart+clsLen+2;
      const propColon=str.indexOf(':',pos);
      const count=parseInt(str.slice(pos,propColon),10);
      pos=propColon+2;
      const obj={__php_class:clsName};
      for(let i=0;i<count;i++){
        const k=parseVal();
        const v=parseVal();
        if(k!==undefined&&v!==undefined)obj[k]=v;
      }
      if(str[pos]==='}')pos+=1;
      if(str[pos]===';')pos+=1;
      return obj;
    }
    return undefined;
  }
  try{return parseVal()}catch(_){return undefined}
};

const formatJsonView=(value)=>{
  if(value===null)return'/* 单元格值为 NULL */';
  if(value==='')return'/* 单元格为空字符串 */';
  if(typeof value!=='string'){
    try{return JSON.stringify(value,null,2)}catch(e){return String(value)}
  }
  const trimmed=value.trim();
  try{
    const parsed=JSON.parse(trimmed);
    return JSON.stringify(parsed,null,2);
  }catch(_){}
  try{
    const parsed=parsePhpSerialized(trimmed);
    if(parsed!==undefined){
      return ['/* 已从 PHP 序列化数据自动解析为 JSON 格式 */',JSON.stringify(parsed,null,2)].join('\\n');
    }
  }catch(_){}
  return ['/* 当前单元格内容非有效 JSON 或 PHP 序列化格式 */',value].join('\\n');
};

const updateCounts=()=>{
  const rows=new Set([...drafts.keys()].map(item=>Number(item.split(':')[0]))),over=rows.size>50||drafts.size>200,count=document.getElementById('batchCounts');
  if(count){
    if(hasNewRow){
      count.textContent='正在录入新行记录 · 点击 ✓ 提交或 ✕ 放弃';
      count.classList.remove('limit-error');
    }else if(drafts.size>0){
      count.textContent=selectedRows.size+' 行已选 · '+rows.size+' 行 / '+drafts.size+' 字段更改'+(over?' · 超出 50 行/200 字段上限':'');
      count.classList.toggle('limit-error',over);
    }else{
      count.textContent=selectedRows.size>0?(selectedRows.size+' 行已选 · 就绪'):'就绪';
      count.classList.remove('limit-error');
    }
  }
  const commitBtn=document.getElementById('commitDrafts');
  if(commitBtn){
    const canCommit=(drafts.size>0||hasNewRow)&&!over&&!saving;
    commitBtn.disabled=!canCommit;
    commitBtn.classList.toggle('has-drafts',drafts.size>0||hasNewRow);
    commitBtn.title=hasNewRow?'应用更改 (✓) - 提交新增行记录':(drafts.size>0?('应用更改 (✓) - 提交 '+rows.size+' 行 / '+drafts.size+' 字段草稿'):'应用更改 (✓) - 暂无更改');
  }
  const discardBtn=document.getElementById('discardDrafts');
  if(discardBtn){
    discardBtn.disabled=(drafts.size===0&&!hasNewRow)||saving;
    discardBtn.classList.toggle('has-drafts',drafts.size>0||hasNewRow);
    discardBtn.title=(drafts.size>0||hasNewRow)?'取消更改 (✕) - 放弃草稿':'取消更改 (✕) - 暂无更改';
  }
  const deleteBtn=document.getElementById('deleteRowBtn');
  if(deleteBtn){
    const canDelete=selectedRows.size>=1&&selectedRows.size<=1000&&!saving&&Boolean(tableEditing?.deletionEnabled);
    deleteBtn.disabled=!canDelete;
    deleteBtn.title=!tableEditing?.deletionEnabled?'当前表不可删除行':(selectedRows.size===0?'删除选中行 (-) - 请勾选要删除的行':(selectedRows.size>1000?'删除选中行 (-) - 一次最多删除 1000 行':('删除所选 '+selectedRows.size+' 行 (-)')));
  }
  document.getElementById('copySelection')?.toggleAttribute('disabled',selectedRows.size===0);
  document.getElementById('exportSelection')?.toggleAttribute('disabled',selectedRows.size===0);
};

const paintRow=r=>{
  const tr=document.querySelector('tr[data-row-index="'+r+'"]');
  if(!tr)return;
  if(isNewRow(r)){
    tr.classList.toggle('active-row',Boolean(activeCell&&activeCell.row===r));
    return;
  }
  const has=[...drafts.keys()].some(item=>item.startsWith(r+':'));
  tr.classList.toggle('has-draft',has);
  tr.classList.toggle('selected',selectedRows.has(r));
  tr.classList.toggle('active-row',Boolean(activeCell&&activeCell.row===r));
  const state=tr.querySelector('.row-state');
  if(state)state.title=has?'含待提交草稿':rowView(r)?.token?'快照已就绪':'只读行';
};

const openDetailForEdit=(r,c)=>{
  setActive(r,c);
  setDetailCollapsed(false);
  document.querySelectorAll('.detail-tab').forEach(t=>t.classList.toggle('active',t.dataset.tab==='text'));
  activeTab='text';
  ['text','json'].forEach(t=>{
    const el=document.getElementById(t+'TabContent');
    if(el)el.classList.toggle('active',t==='text');
  });
  updateDetail();
  if(detailEditor&&!detailEditor.disabled){
    detailEditor.focus();
    detailEditor.select();
  }
  detailPanel?.scrollIntoView({behavior:'smooth',block:'nearest'});
  setStatus('已在下方展开详情面板，可直接编辑修改');
};

const paintCell=(r,c)=>{
  if(inline&&inline.row===r&&inline.column===c)return;
  const cell=document.querySelector('td[data-row="'+r+'"][data-column="'+c+'"]');
  if(!cell)return;
  const input=cell.querySelector('.inline-editor');
  if(input){
    input.remove();
  }
  cell.classList.remove('editing');
  let view=cell.querySelector('.cell-value');
  if(!view){
    view=document.createElement('div');
    view.className='cell-value';
    cell.appendChild(view);
  }
  const value=current(r,c);
  const isAutoInc=Boolean(isNewRow(r)&&columnView(c)?.autoIncrement);
  const colName=(tableColumns[c]||'').toLowerCase();
  const isExplain=tableColumns.some(col=>col.toLowerCase()==='select_type');
  if(isExplain&&colName==='type'&&value==='ALL'){
    view.textContent='';
    const badge=document.createElement('span');
    badge.className='explain-badge danger';
    badge.title='全表扫描：该表未走索引，建议建立合适索引进行调优';
    badge.textContent='ALL (全表扫描)';
    view.appendChild(badge);
  }else if(isExplain&&colName==='type'&&(value==='eq_ref'||value==='const')){
    view.textContent='';
    const badge=document.createElement('span');
    badge.className='explain-badge success';
    badge.title='主键/唯一索引等值查找，性能极高';
    badge.textContent=String(value)+' (极快)';
    view.appendChild(badge);
  }else if(isExplain&&colName==='type'&&value==='range'){
    view.textContent='';
    const badge=document.createElement('span');
    badge.className='explain-badge info';
    badge.title='索引范围扫描';
    badge.textContent=String(value);
    view.appendChild(badge);
  }else if(isExplain&&colName==='key'&&value===null){
    view.textContent='';
    const badge=document.createElement('span');
    badge.className='explain-badge warning';
    badge.title='未命中任何索引';
    badge.textContent='NULL (无索引)';
    view.appendChild(badge);
  }else if(isExplain&&colName==='extra'&&typeof value==='string'&&value.includes('Using filesort')){
    view.textContent='';
    const badge=document.createElement('span');
    badge.className='explain-badge warning';
    badge.title='额外文件排序：未利用索引排序，可能影响性能';
    badge.textContent=String(value);
    view.appendChild(badge);
  }else{
    view.textContent=isAutoInc?'(自动递增)':(value===null?'NULL':String(value));
  }
  view.classList.toggle('null',!isAutoInc&&value===null);
  cell.classList.toggle('autoincrement',isAutoInc);
  cell.classList.toggle('draft',drafts.has(key(r,c))||Boolean(isNewRow(r)&&value!==null));
  const isActive=Boolean(activeCell?.row===r&&activeCell?.column===c);
  cell.classList.toggle('active',isActive);
  let detailBtn=cell.querySelector('.cell-detail-btn');
  if(isActive){
    if(!detailBtn){
      detailBtn=document.createElement('button');
      detailBtn.className='cell-detail-btn';
      detailBtn.type='button';
      detailBtn.title='展开详情并修改';
      detailBtn.setAttribute('aria-label','展开详情并修改');
      detailBtn.innerHTML='<svg class="cell-detail-icon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="6.5" cy="6.5" r="4.5"/><line x1="10" y1="10" x2="14" y2="14"/><line x1="6.5" y1="4.5" x2="6.5" y2="8.5"/><line x1="4.5" y1="6.5" x2="8.5" y2="6.5"/></svg>';
      detailBtn.addEventListener('click',e=>{
        e.stopPropagation();
        openDetailForEdit(r,c);
      });
      cell.appendChild(detailBtn);
    }
  }else if(detailBtn){
    detailBtn.remove();
  }
};

const validateJson=(value,column)=>{
  if(column?.dataType!=='json'||value===null||value==='')return '';
  try{JSON.parse(value);return ''}catch{return '请输入有效 JSON。'}
};

const updateGutter=()=>{
  const lines=(detailEditor?.value||'').split('\\n').length;
  const gutter=document.querySelector('#textTabContent .editor-gutter');
  if(gutter)gutter.innerHTML=Array.from({length:Math.max(1,lines)},(_,i)=>'<span class="line-number">'+(i+1)+'</span>').join('');
};

const updateJsonGutter=()=>{
  const jsonViewer=document.getElementById('jsonViewer');
  const lines=(jsonViewer?.value||'').split('\\n').length;
  const gutter=document.getElementById('jsonGutter');
  if(gutter)gutter.innerHTML=Array.from({length:Math.max(1,lines)},(_,i)=>'<span class="line-number">'+(i+1)+'</span>').join('');
};

const updateDetailTabViews=(value)=>{
  const jsonViewer=document.getElementById('jsonViewer');
  if(jsonViewer){
    jsonViewer.value=formatJsonView(value);
    updateJsonGutter();
  }
};

const updateDetail=()=>{
  if(!detailEditor||!detailMeta)return;
  if(!activeCell){
    detailEditor.value='';detailEditor.disabled=true;
    detailMeta.textContent='选择单元格查看完整内容；双击或 F2 进行网格编辑。';
    if(detailError)detailError.textContent='';
    if(nullSwitch){nullSwitch.classList.remove('visible');nullSwitch.hidden=true;}
    if(formatJsonBtn){formatJsonBtn.classList.add('hidden');formatJsonBtn.hidden=true;}
    updateGutter();updateDetailTabViews(null);
    return;
  }
  const r=activeCell.row,c=activeCell.column,column=columnView(c),value=current(r,c),canEdit=editable(r,c);
  detailMeta.textContent='第 '+(r+1)+' 行 · '+(tableColumns[c]??'字段')+' · '+(column?.columnType??'只读')+(canEdit?' · 可编辑':' · 只读');
  detailEditor.value=value===null?'':String(value);
  detailEditor.disabled=!canEdit||value===null||saving;
  detailEditor.dataset.row=String(r);
  detailEditor.dataset.column=String(c);
  if(nullSwitch){
    const showNull=Boolean(canEdit&&column?.nullable);
    nullSwitch.classList.toggle('visible',showNull);
    nullSwitch.hidden=!showNull;
    if(showNull){
      nullSwitch.setAttribute('aria-checked',String(value===null));
      const lbl=nullSwitch.querySelector('.null-label');
      if(lbl)lbl.textContent=value===null?'已设为 NULL':'设为 NULL';
      nullSwitch.title=value===null?'当前为 NULL，点击可输入内容':'点击将当前字段设为 NULL';
    }
  }
  if(formatJsonBtn){
    const showFormat=Boolean(canEdit&&(column?.dataType==='json'||(typeof value==='string'&&value.trim().startsWith('{'))));
    formatJsonBtn.classList.toggle('hidden',!showFormat);
    formatJsonBtn.hidden=!showFormat;
  }
  if(detailError)detailError.textContent=validateJson(value,column);
  updateGutter();
  updateDetailTabViews(value);
};

const setActive=(r,c)=>{
  const prev=activeCell;
  activeCell={row:r,column:c};
  if(prev){
    paintCell(prev.row,prev.column);
    if(prev.row!==r)paintRow(prev.row);
  }
  paintCell(r,c);
  paintRow(r);
  updateDetail();
  persist();
};

const setDraft=(r,c,value)=>{
  if(isNewRow(r)){
    newRowValues[tableColumns[c]]=value;
    paintCell(r,c);
    updateCounts();
    updateDetail();
    persist();
    return;
  }
  const original=tableRows[r]?.[c]??null;
  if(value===original)drafts.delete(key(r,c));
  else drafts.set(key(r,c),value);
  paintCell(r,c);
  paintRow(r);
  updateCounts();
  updateDetail();
  persist();
};

const restore=()=>{
  const saved=vscode.getState?.();
  if(saved&&typeof saved.detailCollapsed==='boolean'){
    detailCollapsed=saved.detailCollapsed;
  }
  if(!tableEditing||saved?.sessionId!==tableEditing.sessionId)return;
  (saved.drafts??[]).forEach(entry=>{if(Array.isArray(entry)&&typeof entry[0]==='string'&&(typeof entry[1]==='string'||entry[1]===null))drafts.set(entry[0],entry[1])});
  (saved.selected??[]).forEach(r=>{if(Number.isInteger(r)&&r>=0&&r<tableRows.length)selectedRows.add(r)});
  if(saved.active&&Number.isInteger(saved.active.row)&&Number.isInteger(saved.active.column))activeCell=saved.active;
};

const finishInline=commit=>{
  if(!inline)return;
  const item=inline;inline=null;
  const cell=document.querySelector('td[data-row="'+item.row+'"][data-column="'+item.column+'"]');
  cell?.classList.remove('editing');
  if(commit)setDraft(item.row,item.column,item.control.value);
  paintCell(item.row,item.column);
};

const startInline=(r,c)=>{
  if(!editable(r,c)||saving)return;
  finishInline(true);
  setActive(r,c);
  const cell=document.querySelector('td[data-row="'+r+'"][data-column="'+c+'"]');
  if(!cell)return;
  cell.classList.add('editing');
  const value=current(r,c);
  const multiline=Boolean(columnView(c)?.multiline);
  const control=document.createElement(multiline?'textarea':'input');
  control.className='inline-editor';
  control.value=value===null?'':String(value);
  control.setAttribute('aria-label','编辑 '+(tableColumns[c]??'字段'));
  const view=cell.querySelector('.cell-value');
  if(view)view.remove();
  const detailBtn=cell.querySelector('.cell-detail-btn');
  if(detailBtn)detailBtn.remove();
  cell.appendChild(control);
  inline={row:r,column:c,control};
  let finished=false;
  control.addEventListener('click',event=>event.stopPropagation());
  control.addEventListener('mousedown',event=>event.stopPropagation());
  control.addEventListener('dblclick',event=>event.stopPropagation());
  control.addEventListener('contextmenu',event=>event.stopPropagation());
  control.addEventListener('keydown',event=>{
    if(event.key==='Escape'){event.preventDefault();finished=true;finishInline(false)}
    else if(event.key==='Enter'&&(!multiline||event.ctrlKey||event.metaKey)){event.preventDefault();finished=true;finishInline(true)}
  });
  control.addEventListener('blur',()=>{if(!finished){finished=true;finishInline(true)}});
  control.focus();
  control.select();
};

restore();
setDetailCollapsed(detailCollapsed);

document.querySelectorAll('td.cell').forEach(cell=>{
  const r=Number(cell.dataset.row),c=Number(cell.dataset.column);
  cell.addEventListener('click',()=>setActive(r,c));
  cell.addEventListener('dblclick',()=>startInline(r,c));
  cell.addEventListener('keydown',event=>{
    if(event.key==='F2'){event.preventDefault();startInline(r,c)}
    else if(event.key==='Enter'){event.preventDefault();setActive(r,c)}
  });
  paintCell(r,c);
});

let sortColumn=null,sortDirection=null;
const applySort=()=>{
  const tbody=document.querySelector('.table-shell tbody');
  if(!tbody)return;
  const newRowEl=tbody.querySelector('tr.new-row');
  tableColumns.forEach((_,c)=>{
    const badge=document.getElementById('sortBadge_'+c);
    if(badge){
      badge.textContent=(sortColumn===c&&sortDirection)?(sortDirection==='asc'?'▲':'▼'):'';
    }
  });
  const rowElements=Array.from(tbody.querySelectorAll('tr[data-row-index]')).filter(tr=>!tr.classList.contains('new-row'));
  if(sortColumn===null||!sortDirection){
    rowElements.sort((a,b)=>Number(a.dataset.rowIndex)-Number(b.dataset.rowIndex));
  }else{
    const c=sortColumn;
    const dir=sortDirection==='asc'?1:-1;
    rowElements.sort((a,b)=>{
      const rA=Number(a.dataset.rowIndex);
      const rB=Number(b.dataset.rowIndex);
      const valA=current(rA,c);
      const valB=current(rB,c);
      if(valA===null&&valB===null)return 0;
      if(valA===null)return -1*dir;
      if(valB===null)return 1*dir;
      const numA=Number(valA);
      const numB=Number(valB);
      if(!isNaN(numA)&&!isNaN(numB)&&valA!==''&&valB!==''){
        return (numA-numB)*dir;
      }
      return String(valA).localeCompare(String(valB),undefined,{numeric:true,sensitivity:'base'})*dir;
    });
  }
  rowElements.forEach(tr=>tbody.appendChild(tr));
  if(newRowEl)tbody.appendChild(newRowEl);
};
document.querySelectorAll('th.grid-th').forEach(th=>{
  th.addEventListener('click',e=>{
    if(e.target.closest('input,label.check'))return;
    const c=Number(th.dataset.columnIndex);
    if(sortColumn===c){
      if(sortDirection==='asc'){
        sortDirection='desc';
      }else if(sortDirection==='desc'){
        sortColumn=null;
        sortDirection=null;
      }
    }else{
      sortColumn=c;
      sortDirection='asc';
    }
    applySort();
  });
});

document.querySelectorAll('tr[data-row-index]').forEach(tr=>{
  const r=Number(tr.dataset.rowIndex);
  tr.addEventListener('click',event=>{
    if(!event.target.closest('td.cell')&&!event.target.closest('label.check')){
      const col=activeCell?.row===r?activeCell.column:0;
      setActive(r,col);
    }
  });
});
document.addEventListener('keydown',event=>{
  if(event.key==='F2'&&activeCell&&!document.querySelector('.overlay.open')){
    event.preventDefault();
    startInline(activeCell.row,activeCell.column);
  }
});
detailEditor?.addEventListener('input',()=>{
  if(activeCell&&editable(activeCell.row,activeCell.column)){
    setDraft(activeCell.row,activeCell.column,detailEditor.value);
    updateGutter();
  }
});
formatJsonBtn?.addEventListener('click',()=>{
  if(!activeCell||!editable(activeCell.row,activeCell.column))return;
  try{
    const val=detailEditor.value;
    const formatted=JSON.stringify(JSON.parse(val),null,2);
    detailEditor.value=formatted;
    setDraft(activeCell.row,activeCell.column,formatted);
    updateGutter();
  }catch(e){
    setStatus('JSON 格式无效，无法格式化','error');
  }
});
nullSwitch?.addEventListener('click',()=>{
  if(!activeCell||!editable(activeCell.row,activeCell.column))return;
  const r=activeCell.row,c=activeCell.column,col=columnView(c);
  if(!col?.nullable)return;
  const cur=current(r,c);
  if(cur===null){
    setDraft(r,c,'');
    if(detailEditor){detailEditor.value='';detailEditor.disabled=false;detailEditor.focus();}
  }else{
    setDraft(r,c,null);
    if(detailEditor){detailEditor.value='';detailEditor.disabled=true;}
  }
  updateDetail();
});
document.querySelectorAll('.detail-tab').forEach(tab=>{
  tab.addEventListener('click',()=>{
    document.querySelectorAll('.detail-tab').forEach(t=>t.classList.remove('active'));
    tab.classList.add('active');
    activeTab=tab.dataset.tab||'text';
    ['text','json'].forEach(t=>{
      const el=document.getElementById(t+'TabContent');
      if(el)el.classList.toggle('active',t===activeTab);
    });
    if(activeCell)updateDetailTabViews(current(activeCell.row,activeCell.column));
  });
});

document.querySelectorAll('input[data-select-row]').forEach(input=>{
  const r=Number(input.dataset.selectRow);
  input.checked=selectedRows.has(r);
  input.addEventListener('change',()=>{
    if(input.checked)selectedRows.add(r);else selectedRows.delete(r);
    paintRow(r);updateCounts();persist();
  });
});
const selectAll=document.getElementById('selectAll');
selectAll?.addEventListener('change',()=>{
  document.querySelectorAll('input[data-select-row]').forEach(input=>{
    input.checked=selectAll.checked;
    const r=Number(input.dataset.selectRow);
    if(selectAll.checked)selectedRows.add(r);else selectedRows.delete(r);
    paintRow(r);
  });
  updateCounts();persist();
});
const selectionRows=()=>[...selectedRows].sort((a,b)=>a-b).map(r=>tableColumns.map((_c,c)=>current(r,c)));
document.getElementById('copySelection')?.addEventListener('click',()=>{
  const rows=selectionRows(),text=[tableColumns,...rows].map(row=>row.map(value=>value===null?'':String(value)).join('\\t')).join('\\n');
  vscode.postMessage({type:'copy',text});
  setStatus('已复制 '+rows.length+' 行');
});
document.getElementById('exportSelection')?.addEventListener('click',()=>{
  const rows=selectionRows();
  setStatus('正在选择导出位置…');
  vscode.postMessage({type:'exportSelectionCsv',columns:tableColumns,rows,suggestedName:(tableEditing?tableEditing.database+'-'+tableEditing.table:'rinda-selection')+'.csv'});
});

let isDraggingRows=false;
let dragStartRow=-1;
let dragLastRow=-1;
let dragMoved=false;

const tableShell=document.querySelector('.table-shell');
tableShell?.addEventListener('mousedown',e=>{
  if(e.button!==0)return;
  if(e.target.closest('input, button, textarea, .inline-editor, .cell-detail-btn'))return;
  const tr=e.target.closest('tr[data-row-index]');
  if(!tr)return;
  isDraggingRows=true;
  dragMoved=false;
  dragStartRow=Number(tr.dataset.rowIndex);
  dragLastRow=dragStartRow;
});

document.querySelectorAll('tr[data-row-index]').forEach(tr=>{
  tr.addEventListener('mouseenter',()=>{
    if(!isDraggingRows)return;
    const currentR=Number(tr.dataset.rowIndex);
    if(currentR===dragLastRow&&dragMoved)return;
    dragMoved=true;
    dragLastRow=currentR;
    const minR=Math.min(dragStartRow,currentR);
    const maxR=Math.max(dragStartRow,currentR);
    selectedRows.clear();
    for(let i=minR;i<=maxR;i++){selectedRows.add(i);}
    document.querySelectorAll('input[data-select-row]').forEach(input=>{
      input.checked=selectedRows.has(Number(input.dataset.selectRow));
    });
    document.querySelectorAll('tr[data-row-index]').forEach(rowEl=>{
      paintRow(Number(rowEl.dataset.rowIndex));
    });
    updateCounts();
  });
});

window.addEventListener('mouseup',()=>{
  if(isDraggingRows){
    isDraggingRows=false;
    if(dragMoved){
      persist();
    }
  }
});

const contextMenu=document.getElementById('tableContextMenu');
let contextTarget=null;

const closeContextMenu=()=>{
  if(contextMenu)contextMenu.hidden=true;
  contextTarget=null;
};

document.addEventListener('click',e=>{
  if(!contextMenu||contextMenu.hidden)return;
  if(!contextMenu.contains(e.target))closeContextMenu();
});

window.addEventListener('blur',closeContextMenu);
document.addEventListener('keydown',e=>{
  if(e.key==='Escape')closeContextMenu();
});

document.querySelector('tbody')?.addEventListener('contextmenu',e=>{
  if(e.target.closest('input, textarea, .inline-editor'))return;
  const cell=e.target.closest('td.cell');
  const tr=e.target.closest('tr[data-row-index]');
  if(!tr)return;
  e.preventDefault();
  const r=Number(tr.dataset.rowIndex);
  const c=cell?Number(cell.dataset.column):0;
  contextTarget={row:r,column:c};

  if(!selectedRows.has(r)){
    selectedRows.clear();
    selectedRows.add(r);
    document.querySelectorAll('input[data-select-row]').forEach(input=>{
      input.checked=selectedRows.has(Number(input.dataset.selectRow));
    });
    document.querySelectorAll('tr[data-row-index]').forEach(rowEl=>{
      paintRow(Number(rowEl.dataset.rowIndex));
    });
    updateCounts();
  }
  setActive(r,c);

  if(!contextMenu)return;
  contextMenu.hidden=false;

  const col=columnView(c);
  const isCellEditable=editable(r,c);
  const isCellNullable=Boolean(isCellEditable&&col?.nullable);

  const setNullBtn=contextMenu.querySelector('[data-action="setNull"]');
  if(setNullBtn)setNullBtn.disabled=!isCellNullable;

  const setEmptyBtn=contextMenu.querySelector('[data-action="setEmpty"]');
  if(setEmptyBtn)setEmptyBtn.disabled=!isCellEditable;

  const deleteBtn=contextMenu.querySelector('[data-action="deleteRows"]');
  const canDel=selectedRows.size>=1&&selectedRows.size<=1000&&!saving&&Boolean(tableEditing?.deletionEnabled);
  if(deleteBtn){
    deleteBtn.disabled=!canDel;
    const label=document.getElementById('ctxDeleteRowsLabel');
    if(label)label.textContent=selectedRows.size>1?('删除所选 '+selectedRows.size+' 行'):'删除选中行';
  }

  const copyRowsLabel=document.getElementById('ctxCopyRowsLabel');
  if(copyRowsLabel){
    copyRowsLabel.textContent=selectedRows.size>1?('复制所选 '+selectedRows.size+' 行记录'):'复制当前行记录';
  }

  const menuWidth=200;
  const menuHeight=280;
  let x=e.clientX;
  let y=e.clientY;
  if(x+menuWidth>window.innerWidth)x=Math.max(10,window.innerWidth-menuWidth-10);
  if(y+menuHeight>window.innerHeight)y=Math.max(10,window.innerHeight-menuHeight-10);
  contextMenu.style.left=x+'px';
  contextMenu.style.top=y+'px';
});

contextMenu?.addEventListener('click',e=>{
  const item=e.target.closest('.menu-item');
  if(!item||item.disabled||!contextTarget)return;
  const action=item.dataset.action;
  const r=contextTarget.row,c=contextTarget.column;
  closeContextMenu();

  if(action==='copyCell'){
    const val=current(r,c);
    vscode.postMessage({type:'copy',text:val===null?'':String(val)});
    setStatus('已复制单元格内容');
  }else if(action==='setNull'){
    if(editable(r,c)&&columnView(c)?.nullable){
      setDraft(r,c,null);
      setStatus('已将第 '+(r+1)+' 行 '+(tableColumns[c]||'字段')+' 设为 NULL');
    }
  }else if(action==='setEmpty'){
    if(editable(r,c)){
      setDraft(r,c,'');
      setStatus('已将第 '+(r+1)+' 行 '+(tableColumns[c]||'字段')+' 设为空白字符串');
    }
  }else if(action==='openDetail'){
    openDetailForEdit(r,c);
  }else if(action==='copyRows'){
    const rows=selectionRows();
    const text=[tableColumns,...rows].map(row=>row.map(v=>v===null?'':String(v)).join('\\t')).join('\\n');
    vscode.postMessage({type:'copy',text});
    setStatus('已复制 '+rows.length+' 行记录');
  }else if(action==='copyInsert'){
    const rows=[...selectedRows].sort((a,b)=>a-b);
    if(!rows.length)return;
    const q=String.fromCharCode(96);
    const tbl=tableEditing?(q+tableEditing.table+q):(q+'table'+q);
    const cols=tableColumns.map(col=>q+col+q).join(', ');
    const valRows=rows.map(rowIdx=>{
      const vals=tableColumns.map((_col,colIdx)=>{
        const v=current(rowIdx,colIdx);
        if(v===null)return 'NULL';
        if(typeof v==='number')return String(v);
        return "'"+String(v).split("'").join("''")+"'";
      }).join(', ');
      return '('+vals+')';
    });
    const sql='INSERT INTO '+tbl+' ('+cols+') VALUES\\n  '+valRows.join(',\\n  ')+';';
    vscode.postMessage({type:'copy',text:sql});
    setStatus('已复制 '+rows.length+' 行的 INSERT 语句');
  }else if(action==='deleteRows'){
    openDelete();
  }else if(action==='selectAll'){
    const selectAllInput=document.getElementById('selectAll');
    if(selectAllInput){
      selectAllInput.checked=true;
      selectAllInput.dispatchEvent(new Event('change'));
    }
  }else if(action==='clearSelection'){
    const selectAllInput=document.getElementById('selectAll');
    if(selectAllInput){
      selectAllInput.checked=false;
      selectAllInput.dispatchEvent(new Event('change'));
    }
  }
});
const overlay=(id,open)=>{
  const node=document.getElementById(id);
  node?.classList.toggle('open',open);
  node?.setAttribute('aria-hidden',String(!open));
  if(open)node?.querySelector('button,input')?.focus();
};
const groupedEdits=()=>{
  const byRow=new Map();
  drafts.forEach((value,k)=>{
    const parts=k.split(':').map(Number),r=parts[0],c=parts[1],changes=byRow.get(r)??{};
    changes[tableColumns[c]]=value;
    byRow.set(r,changes);
  });
  return[...byRow].sort((a,b)=>a[0]-b[0]).map(([r,changes])=>({row:r,token:rowView(r)?.token,changes}));
};
const openCommit=()=>{
  if(hasNewRow){
    finishInline(true);
    const insertValues={};
    tableColumns.forEach((col,c)=>{
      if(columnView(c)?.autoIncrement)return;
      const val=newRowValues[col];
      if(val!==undefined&&val!==null){
        insertValues[col]=val;
      }else if(val===null&&columnView(c)?.nullable){
        insertValues[col]=null;
      }
    });
    const lines=[
      (tableEditing?.database??'')+'.'+(tableEditing?.table??''),
      '新增 1 行记录 · 已填入 '+Object.keys(insertValues).length+' 个字段',
      '',
      '字段值预览：',
      ...Object.entries(insertValues).map(([k,v])=>k+' = '+(v===null?'NULL':String(v)))
    ];
    document.getElementById('commitSummary').textContent=lines.join('\\n');
    document.getElementById('commitMessage').textContent='';
    overlay('commitOverlay',true);
    return;
  }
  const edits=groupedEdits();
  if(!edits.length)return;
  const fields=edits.reduce((n,item)=>n+Object.keys(item.changes).length,0);
  const diffs=edits.map(item=>'第 '+(item.row+1)+' 行: '+Object.entries(item.changes).map(([col,val])=>col+' = '+(val===null?'NULL':String(val))).join(', ')).slice(0,10);
  const lines=[
    (tableEditing?.database??'')+'.'+(tableEditing?.table??''),
    edits.length+' 行 · '+fields+' 字段',
    '定位：'+(tableEditing?.locatorLabel??'默认定位'),
    '',
    '明细摘要：',
    ...diffs
  ];
  document.getElementById('commitSummary').textContent=lines.join('\\n');
  document.getElementById('commitMessage').textContent='';
  overlay('commitOverlay',true);
};
const discardAll=()=>{
  if(hasNewRow){
    document.querySelector('tr.new-row')?.remove();
    hasNewRow=false;
    newRowValues={};
    if(activeCell&&activeCell.row===tableRows.length){
      activeCell=null;
    }
  }
  const affected=new Set([...drafts.keys()].map(k=>Number(k.split(':')[0])));
  drafts.clear();
  affected.forEach(r=>{tableColumns.forEach((_c,c)=>paintCell(r,c));paintRow(r)});
  updateCounts();updateDetail();persist();
  setStatus('已取消全部草稿');
};
const openDelete=()=>{
  if(selectedRows.size<1||selectedRows.size>1000)return;
  const rows=[...selectedRows].sort((a,b)=>a-b);
  const unlocatable=rows.filter(r=>!rowView(r)?.token);
  if(unlocatable.length>0){
    setStatus('所选第 '+unlocatable.map(r=>r+1).join(', ')+' 行缺少可靠主键定位，不可删除。','error');
    return;
  }
  const isSingle=rows.length===1;
  const title=document.getElementById('deleteTitle');
  if(title)title.textContent=isSingle?'确认安全删除该行':'确认安全删除所选 '+rows.length+' 行';
  const desc=document.querySelector('#deleteOverlay .dialog-copy');
  if(desc)desc.textContent=isSingle?'将按确定性定位键在事务中核对原始快照并执行精确单行删除。此操作无法撤销。':'将按确定性定位键在事务中核对原始快照并执行原子批量删除（任一行冲突整批回滚）。此操作无法撤销。';
  const previews=rows.slice(0,5).map(r=>'第 '+(r+1)+' 行: '+tableColumns.slice(0,4).map((col,c)=>col+'='+(current(r,c)===null?'NULL':String(current(r,c)))).join(', '));
  if(rows.length>5)previews.push('... 等共 '+rows.length+' 行');
  const summaryLines=[
    '表：'+(tableEditing?.database??'')+'.'+(tableEditing?.table??''),
    '数量：已选 '+rows.length+' 行',
    '定位：'+(tableEditing?.locatorLabel??'默认'),
    '',
    '数据预览：',
    ...previews
  ];
  document.getElementById('deleteSummary').textContent=summaryLines.join('\\n');
  const input=document.getElementById('deleteConfirmationInput');
  const confirmBtn=document.getElementById('confirmDelete');
  if(input){input.value='';input.focus();}
  if(confirmBtn){
    confirmBtn.disabled=true;
    confirmBtn.textContent=isSingle?'确认删除该行':'确认删除所选 '+rows.length+' 行';
  }
  document.getElementById('deleteMessage').textContent='';
  overlay('deleteOverlay',true);
};
document.getElementById('deleteConfirmationInput')?.addEventListener('input',event=>{
  const confirmBtn=document.getElementById('confirmDelete');
  if(confirmBtn)confirmBtn.disabled=event.target.value.trim()!=='DELETE';
});
document.getElementById('cancelDelete')?.addEventListener('click',()=>overlay('deleteOverlay',false));
document.getElementById('confirmDelete')?.addEventListener('click',()=>{
  if(selectedRows.size<1||selectedRows.size>1000)return;
  const rows=[...selectedRows].sort((a,b)=>a-b);
  const tokens=rows.map(r=>rowView(r)?.token).filter(Boolean);
  if(tokens.length!==rows.length)return;
  setSaving(true);
  document.getElementById('deleteMessage').textContent='正在原子安全删除并核对…';
  vscode.postMessage({type:'deleteRows',tokens,operationId:operationId(),confirmation:'DELETE'});
});
document.getElementById('commitDrafts')?.addEventListener('click',openCommit);
document.getElementById('discardDrafts')?.addEventListener('click',discardAll);
document.getElementById('deleteRowBtn')?.addEventListener('click',openDelete);
document.getElementById('cancelCommit')?.addEventListener('click',()=>{submitThenContinue=false;overlay('commitOverlay',false)});
const setSaving=value=>{
  saving=value;
  document.querySelectorAll('button,input,textarea').forEach(control=>{if(control.id!=='cancelLeave')control.disabled=value});
  updateCounts();if(!value)updateDetail();
};
document.getElementById('confirmCommit')?.addEventListener('click',()=>{
  if(hasNewRow){
    finishInline(true);
    const insertValues={};
    tableColumns.forEach((col,c)=>{
      if(columnView(c)?.autoIncrement)return;
      const val=newRowValues[col];
      if(val!==undefined){
        insertValues[col]=val;
      }
    });
    setSaving(true);
    document.getElementById('commitMessage').textContent='正在插入新记录并刷新…';
    vscode.postMessage({type:'insertRow',operationId:operationId(),values:insertValues});
    return;
  }
  const edits=groupedEdits();
  if(!edits.length||edits.some(item=>!item.token))return;
  setSaving(true);
  document.getElementById('commitMessage').textContent='正在锁定、核对并原子提交…';
  vscode.postMessage({type:'saveBatch',operationId:operationId(),edits:edits.map(item=>({token:item.token,changes:item.changes}))});
});

const addRowBtn=document.getElementById('addRowBtn');
const addNewRow=()=>{
  if(!tableEditing?.enabled||saving)return;
  const newR=tableRows.length;
  if(hasNewRow){
    const firstCol=tableColumns.findIndex((_,c)=>editable(newR,c));
    const targetCol=firstCol>=0?firstCol:0;
    setActive(newR,targetCol);
    startInline(newR,targetCol);
    return;
  }
  finishInline(true);
  hasNewRow=true;
  newRowValues={};
  tableColumns.forEach(c=>{newRowValues[c]=null;});

  const tbody=document.querySelector('.table-shell tbody');
  if(!tbody)return;
  const tr=document.createElement('tr');
  tr.className='new-row';
  tr.dataset.rowIndex=String(newR);

  const tdSel=document.createElement('td');
  tdSel.className='sticky-cell select-col';
  tdSel.innerHTML='<label class="check"><input type="checkbox" disabled><span class="check-box">+</span></label>';
  tr.appendChild(tdSel);

  const tdStatus=document.createElement('td');
  tdStatus.className='sticky-cell status-col';
  tdStatus.innerHTML='<span class="row-state new-row-state" title="新增行草稿">★</span>';
  tr.appendChild(tdStatus);

  tableColumns.forEach((col,c)=>{
    const isAutoInc=Boolean(columnView(c)?.autoIncrement);
    const canEdit=editable(newR,c);
    const td=document.createElement('td');
    td.className='cell'+(canEdit?' editable':'')+(isAutoInc?' autoincrement':'');
    td.dataset.row=String(newR);
    td.dataset.column=String(c);
    td.tabIndex=0;
    td.setAttribute('aria-label',col+'：'+(isAutoInc?'自动递增':(canEdit?'双击或按 F2 录入新值':'只读')));
    td.innerHTML='<div class="cell-value'+(isAutoInc?'':' null')+'">'+(isAutoInc?'(自动递增)':'NULL')+'</div>';

    td.addEventListener('click',()=>setActive(newR,c));
    td.addEventListener('dblclick',()=>startInline(newR,c));
    td.addEventListener('keydown',event=>{
      if(event.key==='F2'){event.preventDefault();startInline(newR,c);}
      else if(event.key==='Enter'){event.preventDefault();setActive(newR,c);}
    });
    tr.appendChild(td);
  });

  tbody.appendChild(tr);
  const shell=document.querySelector('.table-shell');
  if(shell)shell.scrollTop=shell.scrollHeight;

  updateCounts();
  setStatus('已添加新记录草稿行，请录入字段值并点击 ✓ 提交');
  const firstCol=tableColumns.findIndex((_,c)=>editable(newR,c));
  const targetCol=firstCol>=0?firstCol:0;
  setActive(newR,targetCol);
  startInline(newR,targetCol);
};
addRowBtn?.addEventListener('click',addNewRow);

let executeNow=()=>{};
let explainNow=()=>{};
const runPending=()=>{
  const action=pendingAction;pendingAction=null;submitThenContinue=false;
  if(action?.kind==='page')vscode.postMessage({type:'page',direction:action.direction});
  else if(action?.kind==='execute')executeNow();
  else if(action?.kind==='explain')explainNow();
  else if(action?.kind==='refresh')vscode.postMessage({type:'refreshPage'});
};
const guarded=action=>{
  if(!drafts.size&&!hasNewRow){pendingAction=action;runPending();return}
  pendingAction=action;overlay('leaveOverlay',true);
};
document.getElementById('cancelLeave')?.addEventListener('click',()=>{pendingAction=null;overlay('leaveOverlay',false)});
document.getElementById('discardLeave')?.addEventListener('click',()=>{discardAll();overlay('leaveOverlay',false);runPending()});
document.getElementById('saveLeave')?.addEventListener('click',()=>{submitThenContinue=true;overlay('leaveOverlay',false);openCommit()});
document.getElementById('refreshBtn')?.addEventListener('click',()=>guarded({kind:'refresh'}));

const sqlEditor=document.getElementById('sqlEditor'),executeButton=document.getElementById('executeSql'),explainButton=document.getElementById('explainSql');
executeNow=()=>{
  const sql=sqlEditor?.value.trim();
  if(!sql){setStatus('请输入要执行的 SQL。','error');sqlEditor?.focus();return}
  if(executeButton){
    executeButton.disabled=true;
    executeButton.textContent='执行中…';
  }
  vscode.postMessage({type:'executeSql',sql});
};
explainNow=()=>{
  let sql=sqlEditor?.value.trim();
  if(!sql){setStatus('请输入要分析的 SQL。','error');sqlEditor?.focus();return}
  sql=sql.replace(/;\s*$/,'');
  if(!/^explain\s+/i.test(sql)){
    sql='EXPLAIN '+sql;
  }
  if(explainButton){
    explainButton.disabled=true;
    explainButton.textContent='分析中…';
  }
  vscode.postMessage({type:'executeSql',sql});
};
executeButton?.addEventListener('click',()=>guarded({kind:'execute'}));
explainButton?.addEventListener('click',()=>guarded({kind:'explain'}));
sqlEditor?.addEventListener('keydown',event=>{
  if((event.metaKey||event.ctrlKey)&&event.key==='Enter'){
    event.preventDefault();
    guarded({kind:'execute'});
  }else if(event.key==='Enter'&&!event.shiftKey){
    event.preventDefault();
    guarded({kind:'execute'});
  }
});
document.getElementById('firstPage')?.addEventListener('click',()=>guarded({kind:'page',direction:-999999}));
document.getElementById('previous')?.addEventListener('click',()=>guarded({kind:'page',direction:-1}));
document.getElementById('next')?.addEventListener('click',()=>guarded({kind:'page',direction:1}));
document.getElementById('toggleSidebarBtn')?.addEventListener('click',()=>{document.querySelector('.workspace')?.classList.toggle('sidebar-collapsed')});
document.getElementById('closeSidebarBtn')?.addEventListener('click',()=>{document.querySelector('.workspace')?.classList.add('sidebar-collapsed')});

window.addEventListener('beforeunload',event=>{if(drafts.size||hasNewRow){event.preventDefault();event.returnValue=''}});
window.addEventListener('message',event=>{
  const data=event.data;
  if(data?.type==='executionState'){
    if(executeButton){executeButton.disabled=Boolean(data.running);executeButton.innerHTML='<svg class="icon" viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"/></svg> '+(data.running?'执行中…':'执行')}
    if(explainButton){explainButton.disabled=Boolean(data.running);explainButton.innerHTML='<svg class="icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg> '+(data.running?'分析中…':'EXPLAIN')}
    if(data.error)setStatus(data.error,'error');
  }
  if(data?.type==='selectionExportState')setStatus(data.message??'',data.ok?'success':'error');
  if(data?.type==='deleteRowState'){
    setSaving(false);
    overlay('deleteOverlay',false);
    if(data.ok){
      selectedRows.clear();
      updateCounts();
      persist();
      setStatus(data.message??'已成功删除','success');
    }else{
      setStatus(data.message??'删除失败','error');
    }
  }
  if(data?.type==='insertRowState'){
    setSaving(false);
    document.getElementById('commitMessage').textContent=data.message??'';
    document.getElementById('commitMessage').className='message'+(data.ok?'':' error');
    if(data.ok){
      hasNewRow=false;
      newRowValues={};
      document.querySelector('tr.new-row')?.remove();
      updateCounts();
      updateDetail();
      persist();
      setStatus(data.message??'新记录已成功插入','success');
      overlay('commitOverlay',false);
      if(submitThenContinue)runPending();
    }else{
      setStatus(data.message??'插入记录失败','error');
    }
  }
  if(data?.type==='batchEditState'){
    setSaving(false);
    document.getElementById('commitMessage').textContent=data.message??'';
    document.getElementById('commitMessage').className='message'+(data.ok?'':' error');
    if(data.ok){
      (data.reloadedRows??[]).forEach(item=>{const r=tableEditing?.rows?.findIndex(row=>row.token===item.token)??-1;if(r>=0)tableRows[r]=item.values});
      const affected=new Set([...drafts.keys()].map(k=>Number(k.split(':')[0])));
      drafts.clear();
      affected.forEach(r=>{tableColumns.forEach((_c,c)=>paintCell(r,c));paintRow(r)});
      updateCounts();updateDetail();persist();
      setStatus(data.message??'更改已成功提交','success');
      overlay('commitOverlay',false);
      if(submitThenContinue)runPending();
    }else{
      setStatus(data.message??'提交失败','error');
    }
  }
});
selectedRows.forEach(paintRow);
[...new Set([...drafts.keys()].map(k=>Number(k.split(':')[0])))].forEach(paintRow);
if(activeCell)paintRow(activeCell.row);
updateCounts();
updateDetail();
persist();
</script></body></html>`;
}

export function buildOverview(overview?: TableOverview, error?: string, editing?: TableEditingView): string {
  if (!overview && !error && !editing) return '';
  const tableName = editing?.table ?? '数据对象';
  const dbName = editing?.database ?? '';
  const isView = overview?.objectType === 'view';
  const objectTypeLabel = isView ? '视图' : '数据表';
  const items = overview ? buildTableOverviewItems(overview) : [];

  const propList: Array<{ label: string; value: string }> = [
    { label: '所属数据库', value: dbName || '—' },
    ...items
  ];
  if (editing?.locatorLabel) {
    propList.push({ label: '定位主键', value: editing.locatorLabel });
  }
  propList.push({
    label: '写状态',
    value: editing?.enabled ? '可靠定位可编辑' : (editing?.reason ?? editing?.editReason ?? '只读')
  });

  const propHtml = propList.map((item) => `
    <div class="overview-item">
      <dt>${escapeHtml(item.label)}</dt>
      <dd>${escapeHtml(item.value)}</dd>
    </div>
  `).join('');

  return `
    <aside class="overview-sidebar" id="overviewSidebar" aria-label="源表概览">
      <div class="overview-header">
        <div class="overview-title-row">
          <div class="table-badge-icon" aria-hidden="true">${icon('table')}</div>
          <div class="overview-title-info">
            <h2 class="overview-table-name" title="${escapeHtml(tableName)}">${escapeHtml(tableName)}</h2>
            <span class="overview-object-tag">${escapeHtml(objectTypeLabel)}</span>
          </div>
          <button id="closeSidebarBtn" class="overview-close-btn" type="button" title="折叠源表概览">${icon('x')}</button>
        </div>
      </div>
      <div class="overview-body">
        <p class="overview-note">基于 MySQL 字典安全估算</p>
        <dl class="overview-grid">${propHtml}</dl>
        ${error ? `<p class="overview-error" role="status">概览不可用：${escapeHtml(error)}</p>` : ''}
      </div>
    </aside>
  `;
}

export function getColumnTypeBadge(columnType?: string, dataType?: string, sampleValues?: (string | null | undefined)[]): string {
  let dt = (dataType || columnType || '').toLowerCase();
  let typeDisplay = (columnType || dataType || '').toUpperCase().slice(0, 16);

  if (!dt && sampleValues && sampleValues.length > 0) {
    const nonNulls = sampleValues.filter((v): v is string => v !== null && v !== undefined);
    if (nonNulls.length > 0) {
      const allNumbers = nonNulls.every(v => /^-?\d+(\.\d+)?$/.test(String(v).trim()));
      const allDates = nonNulls.every(v => /^\d{4}-\d{2}-\d{2}/.test(String(v).trim()));
      const allJson = nonNulls.every(v => {
        const s = String(v).trim();
        return (s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']'));
      });
      if (allNumbers) {
        dt = 'int';
        typeDisplay = 'NUM';
      } else if (allDates) {
        dt = 'datetime';
        typeDisplay = 'DATETIME';
      } else if (allJson) {
        dt = 'json';
        typeDisplay = 'JSON';
      } else {
        dt = 'varchar';
        typeDisplay = 'TEXT';
      }
    }
  }

  let iconText = 'ABC';
  if (dt.includes('int') || dt.includes('decimal') || dt.includes('numeric') || dt.includes('float') || dt.includes('double')) {
    iconText = '123';
  } else if (dt.includes('json')) {
    iconText = '{ }';
  } else if (dt.includes('date') || dt.includes('time') || dt.includes('year')) {
    iconText = 'DAT';
  } else if (dt.includes('blob') || dt.includes('binary') || dt.includes('bit')) {
    iconText = '01';
  }
  if (!typeDisplay) {
    typeDisplay = 'ANY';
  }
  return `<span class="col-type-badge"><span class="type-icon">${iconText}</span><span class="type-name">${escapeHtml(typeDisplay)}</span></span>`;
}

export function buildTable(
  result: QueryResult,
  editing?: TableEditingView,
  page?: number,
  canGoBack?: boolean,
  canGoForward?: boolean
): string {
  const selectionHead = `<th class="sticky-cell select-col" scope="col"><label class="check"><input id="selectAll" type="checkbox" aria-label="选择全部行"><span class="check-box">${icon('check')}</span></label></th><th class="sticky-cell status-col" scope="col">状态</th>`;
  const headings = result.columns.map((column, idx) => {
    const colMeta = editing?.columns[idx];
    const sampleValues = result.rows.slice(0, 10).map(r => r[idx]);
    const typeBadge = getColumnTypeBadge(colMeta?.columnType, colMeta?.dataType, sampleValues);
    return `<th scope="col" class="grid-th" data-column-index="${idx}" title="点击按此列快速排序（升序 / 降序 / 恢复默认）"><div class="col-head-box"><span class="col-head-name">${escapeHtml(column)}<span class="sort-badge" id="sortBadge_${idx}"></span></span>${typeBadge}</div></th>`;
  }).join('');
  const body = result.rows.map((row, rowIndex) => {
    const cells = row.map((value, columnIndex) => {
      const column = editing?.columns[columnIndex];
      const canEdit = Boolean(editing?.enabled && editing.rows[rowIndex]?.token && column?.editable);
      const reason = canEdit ? '双击或按 F2 暂存编辑' : column?.readOnlyReason ?? '选择查看完整内容';
      return `<td class="cell${canEdit ? ' editable' : ''}" data-row="${rowIndex}" data-column="${columnIndex}" tabindex="0" aria-label="${escapeHtml(result.columns[columnIndex] ?? '字段')}：${escapeHtml(reason)}"><div class="cell-value${value === null ? ' null' : ''}">${value === null ? 'NULL' : escapeHtml(value)}</div></td>`;
    }).join('');
    return `<tr data-row-index="${rowIndex}"><td class="sticky-cell select-col"><label class="check"><input type="checkbox" data-select-row="${rowIndex}" aria-label="选择第 ${rowIndex + 1} 行"><span class="check-box">${icon('check')}</span></label></td><td class="sticky-cell status-col"><span class="row-state" title="${editing?.rows[rowIndex]?.token ? '快照已就绪' : '只读行'}"></span></td>${cells}</tr>`;
  }).join('');

  const detailPanel = `
    <div class="detail-panel collapsed" id="detailPanel">
      <div class="detail-tabs">
        <button class="detail-tab active" data-tab="text" type="button">文本 (可编辑)</button>
        <button class="detail-tab" data-tab="json" type="button">JSON (只读)</button>
        <span class="detail-col-info" id="detailMeta">选择单元格查看完整内容</span>
        <div class="detail-tab-tools">
          <button id="formatJsonBtn" class="detail-tool-btn" type="button" hidden>格式化并暂存</button>
          <button id="detailNull" class="null-switch" type="button" role="switch" aria-checked="false" hidden title="将当前字段设为 NULL / 取消 NULL">
            <span class="switch-track"><span class="switch-thumb"></span></span><span class="null-label">设为 NULL</span>
          </button>
          <button id="toggleDetailBtn" class="detail-tool-btn" type="button" title="收起详情面板">收起 ▾</button>
        </div>
      </div>
      <div class="detail-editor-container">
        <div id="textTabContent" class="tab-pane active">
          <div class="editor-gutter"><span class="line-number">1</span></div>
          <textarea id="detailEditor" class="detail-editor" aria-label="活动单元格完整内容" disabled spellcheck="false"></textarea>
        </div>
        <div id="jsonTabContent" class="tab-pane">
          <div id="jsonGutter" class="json-gutter"><span class="line-number">1</span></div>
          <textarea id="jsonViewer" class="detail-editor" readonly aria-label="只读 JSON 格式化视图" spellcheck="false" placeholder="无有效 JSON 内容"></textarea>
        </div>
      </div>
      <div id="detailError" class="field-error" role="alert"></div>
    </div>
  `;

  const navicatBottomBar = `
    <div class="navicat-bottom-bar" aria-label="数据表操作导航条">
      <div class="navicat-actions">
        <button id="addRowBtn" class="navicat-btn" type="button" title="${editing?.enabled ? '插入新行记录 (+)' : '添加新行 (当前表不可编辑)'}" ${editing?.enabled ? '' : 'disabled'}>${icon('plus')}</button>
        <button id="deleteRowBtn" class="navicat-btn" type="button" title="删除选中行 (-)" disabled>${icon('minus')}</button>
        <button id="commitDrafts" class="navicat-btn btn-commit" type="button" title="应用更改 (✓) - 暂无更改" disabled>${icon('check')}</button>
        <button id="discardDrafts" class="navicat-btn btn-discard" type="button" title="取消更改 (✕) - 暂无更改" disabled>${icon('x')}</button>
        <button id="refreshBtn" class="navicat-btn" type="button" title="刷新数据 (↻)">${icon('refresh')}</button>
        <div class="bar-divider"></div>
        <button id="copySelection" class="navicat-text-btn" type="button" disabled title="复制所选行">${icon('copy')} 复制选择</button>
        <button id="exportSelection" class="navicat-text-btn" type="button" disabled title="导出所选行为 CSV">${icon('download')} 导出 CSV</button>
        <span id="batchCounts" class="navicat-status-text">就绪</span>
      </div>
      <div class="navicat-pagination">
        <button id="bottomToggleDetailBtn" class="navicat-text-btn" type="button" title="展开/收起详情面板">展开详情 ▴</button>
        <div class="bar-divider"></div>
        ${page !== undefined ? `
          <button id="firstPage" class="navicat-btn" type="button" title="第一页" ${canGoBack ? '' : 'disabled'}>${icon('chevrons-left')}</button>
          <button id="previous" class="navicat-btn" type="button" title="上一页" ${canGoBack ? '' : 'disabled'}>${icon('chevron-left')}</button>
          <span class="navicat-page-label">第 ${page + 1} 页</span>
          <button id="next" class="navicat-btn" type="button" title="下一页" ${canGoForward ? '' : 'disabled'}>${icon('chevron-right')}</button>
        ` : ''}
      </div>
    </div>
  `;

  return `<div class="table-shell" role="region" aria-label="数据表格"><table><thead><tr>${selectionHead}${headings}</tr></thead><tbody>${body}</tbody></table></div>${detailPanel}${navicatBottomBar}`;
}

export function icon(name: 'check' | 'x' | 'copy' | 'download' | 'chevron-down' | 'chevron-up' | 'plus' | 'minus' | 'refresh' | 'chevron-left' | 'chevron-right' | 'chevrons-left' | 'table' | 'search' | 'play' | 'info'): string {
  const paths: Record<string, string> = {
    check: '<path d="m20 6-11 11-5-5"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    minus: '<path d="M5 12h14"/>',
    refresh: '<path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/>',
    copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
    'chevron-down': '<path d="m6 9 6 6 6-6"/>',
    'chevron-up': '<path d="m18 15-6-6-6 6"/>',
    'chevron-left': '<path d="m15 18-6-6 6-6"/>',
    'chevron-right': '<path d="m9 18 6-6-6-6"/>',
    'chevrons-left': '<path d="m11 17-5-5 5-5M18 17l-5-5 5-5M6 19V5"/>',
    table: '<path d="M3 3h18v18H3zM3 9h18M3 15h18M9 3v18M15 3v18"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>',
    play: '<polygon points="5 3 19 12 5 21 5 3"/>',
    info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>'
  };
  return `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${paths[name] ?? ''}</svg>`;
}

export function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replaceAll('<', '\\u003c');
}

export function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}

export function emptyResult(): QueryResult {
  return { columns: [], rows: [], rowCount: 0, affectedRows: 0, durationMs: 0, truncated: false, hasMore: false };
}
