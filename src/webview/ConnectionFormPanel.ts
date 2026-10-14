import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { ConnectionProfile } from '../connection/types.js';
import {
  type ConnectionFormResult,
  validateConnectionFormPayload
} from './connectionFormModel.js';

export class ConnectionFormPanel {
  private static activePanel: vscode.WebviewPanel | undefined;
  private static activePromise: Promise<ConnectionFormResult | undefined> | undefined;

  public static show(current?: ConnectionProfile): Promise<ConnectionFormResult | undefined> {
    if (this.activePanel && this.activePromise) {
      this.activePanel.reveal(vscode.ViewColumn.Active);
      return this.activePromise;
    }

    const title = current ? `编辑连接 · ${current.name}` : '新建 MySQL 连接';
    const panel = vscode.window.createWebviewPanel(
      'rindaMysql.connectionForm',
      title,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    panel.webview.html = buildConnectionFormHtml(current);
    this.activePanel = panel;

    this.activePromise = new Promise((resolve) => {
      let settled = false;
      const finish = (result: ConnectionFormResult | undefined, closePanel: boolean): void => {
        if (settled) return;
        settled = true;
        if (ConnectionFormPanel.activePanel === panel) {
          ConnectionFormPanel.activePanel = undefined;
          ConnectionFormPanel.activePromise = undefined;
        }
        resolve(result);
        if (closePanel) panel.dispose();
      };

      panel.webview.onDidReceiveMessage(async (message: unknown) => {
        if (!isConnectionFormMessage(message)) return;
        if (message.type === 'cancel') {
          finish(undefined, true);
          return;
        }
        if (message.type === 'submit') {
          const validation = validateConnectionFormPayload(message.payload, current);
          if (!validation.result) {
            await panel.webview.postMessage({ type: 'validation', errors: validation.errors });
            return;
          }
          finish(validation.result, true);
        }
      });
      panel.onDidDispose(() => finish(undefined, false));
    });

    return this.activePromise;
  }
}

function buildConnectionFormHtml(current?: ConnectionProfile): string {
  const nonce = randomBytes(16).toString('base64');
  const initialState = JSON.stringify({ ssl: current?.ssl ?? false }).replaceAll('<', '\\u003c');
  const mode = current ? '编辑连接' : '新建连接';
  const passwordHelp = current
    ? '留空将保留 SecretStorage 中的现有密码。'
    : '允许空密码；密码只保存到 VS Code SecretStorage。';

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <title>${mode}</title>
  <style nonce="${nonce}">
    /* Reset / box model */
    *, *::before, *::after { box-sizing: border-box; }
    *:focus, *:focus-visible { outline: none; }
    html, body { margin: 0; min-height: 100%; }
    button, input { font: inherit; }

    /* Typography */
    body { font-family: var(--font-ui); font-size: 14px; line-height: 1.5; color: var(--text-primary); background: var(--canvas); -webkit-font-smoothing: antialiased; }
    h1, p { margin: 0; }
    h1 { font-size: 18px; line-height: 1.35; font-weight: 600; color: var(--text-strong); }

    /* Semantic variables */
    :root {
      color-scheme: light dark;
      --canvas: var(--vscode-editor-background);
      --surface: var(--vscode-sideBar-background);
      --surface-2: var(--vscode-editorWidget-background);
      --surface-hover: var(--vscode-list-hoverBackground);
      --overlay: var(--vscode-widget-shadow);
      --brand: var(--vscode-button-background);
      --brand-hover: var(--vscode-button-hoverBackground);
      --brand-active: var(--vscode-button-hoverBackground);
      --brand-weak: var(--vscode-list-activeSelectionBackground);
      --on-brand: var(--vscode-button-foreground);
      --text-strong: var(--vscode-editor-foreground);
      --text-primary: var(--vscode-foreground);
      --text-secondary: var(--vscode-descriptionForeground);
      --text-tertiary: var(--vscode-disabledForeground);
      --text-disabled: var(--vscode-disabledForeground);
      --border: var(--vscode-panel-border);
      --border-strong: var(--vscode-focusBorder);
      --border-weak: var(--vscode-widget-border);
      --success: var(--vscode-testing-iconPassed);
      --success-bg: var(--vscode-editorWidget-background);
      --warning: var(--vscode-editorWarning-foreground);
      --warning-bg: var(--vscode-editorWidget-background);
      --danger: var(--vscode-errorForeground);
      --danger-bg: var(--vscode-inputValidation-errorBackground);
      --info: var(--vscode-editorInfo-foreground);
      --info-bg: var(--vscode-editorWidget-background);
      --shadow-sm: 0 2px 8px var(--vscode-widget-shadow);
      --shadow-md: 0 6px 20px var(--vscode-widget-shadow);
      --shadow-lg: 0 8px 32px var(--vscode-widget-shadow);
      --font-ui: var(--vscode-font-family);
      --font-data: var(--vscode-editor-font-family);
      --max: 760px;
      --gutter: 24px;
    }

    /* Custom scrollbar */
    * { scrollbar-width: thin; scrollbar-color: var(--text-tertiary) var(--surface-2); }
    ::-webkit-scrollbar { width: 10px; height: 10px; }
    ::-webkit-scrollbar-track { background: var(--surface-2); }
    ::-webkit-scrollbar-thumb { background: var(--text-tertiary); border: 2px solid var(--surface-2); border-radius: 6px; }
    ::-webkit-scrollbar-thumb:hover { background: var(--text-secondary); }

    /* Navigation */
    header { position: sticky; z-index: 100; top: 0; padding: 16px var(--gutter); background: var(--surface); border-bottom: 1px solid var(--border); box-shadow: var(--shadow-sm); }
    header p { margin-top: 4px; color: var(--text-secondary); font-size: 12px; }

    /* Primary work area */
    main { width: min(var(--max), 100%); margin: 0 auto; padding: 24px var(--gutter) 40px; }

    /* Main layout and sections */
    form { display: grid; grid-template-columns: minmax(0, 2fr) minmax(144px, 1fr); gap: 20px 16px; }
    .field { min-width: 0; display: grid; gap: 6px; }
    .field-wide, .ssl-row, .form-error, .actions { grid-column: 1 / -1; }
    label, .field-label { color: var(--text-strong); font-size: 13px; font-weight: 600; }
    .help { min-height: 18px; color: var(--text-secondary); font-size: 12px; }
    .field-error { min-height: 18px; color: var(--danger); font-size: 12px; }
    .form-error { max-height: 0; overflow: hidden; padding: 0 12px; color: var(--danger); background: var(--danger-bg); border-radius: 4px; opacity: 0; visibility: hidden; transition: max-height 180ms ease, padding 180ms ease, opacity 180ms ease, visibility 0s linear 180ms; }
    .form-error.visible { max-height: 80px; padding: 10px 12px; opacity: 1; visibility: visible; transition-delay: 0s; }
    .ssl-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 0; }
    .ssl-copy { min-width: 0; }
    .ssl-copy .help { margin-top: 4px; }
    .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; padding-top: 16px; border-top: 1px solid var(--border); }

    /* Components */
    input { width: 100%; min-height: 38px; padding: 8px 10px; color: var(--text-primary); background: var(--surface-2); border: 1px solid var(--border); border-radius: 4px; caret-color: var(--brand); transition: background-color 180ms ease, border-color 180ms ease, box-shadow 180ms ease; }
    input:hover { background: var(--surface-hover); }
    input:focus { border-color: var(--border-strong); box-shadow: 0 0 0 2px var(--brand-weak), inset 0 0 0 1px var(--border-strong); }
    input[aria-invalid="true"] { border-color: var(--danger); box-shadow: inset 0 0 0 1px var(--danger); }
    input:disabled { opacity: 0.45; cursor: not-allowed; }
    button { min-height: 34px; padding: 6px 12px; color: var(--text-primary); background: var(--surface-2); border: 1px solid var(--border); border-radius: 4px; cursor: pointer; transition: color 180ms ease, background-color 180ms ease, box-shadow 180ms ease, transform 80ms ease, opacity 180ms ease; }
    button:hover { background: var(--surface-hover); box-shadow: var(--shadow-sm); }
    button:focus-visible { box-shadow: 0 0 0 2px var(--border-strong); }
    button:active { transform: scale(0.97); }
    button:disabled { opacity: 0.45; cursor: not-allowed; box-shadow: none; }
    .primary { color: var(--on-brand); background: var(--brand); border-color: var(--brand); }
    .primary:hover { background: var(--brand-hover); }
    .primary:active { background: var(--brand-active); }
    .switch { flex: 0 0 auto; display: inline-flex; align-items: center; gap: 8px; min-width: 92px; border: 0; background: transparent; box-shadow: none; }
    .switch:hover { background: var(--surface-hover); box-shadow: none; }
    .switch-track { position: relative; z-index: 1; width: 40px; height: 22px; border-radius: 12px; background: var(--text-tertiary); transition: background-color 180ms ease; }
    .switch-thumb { position: absolute; z-index: 2; top: 3px; left: 3px; width: 16px; height: 16px; border-radius: 50%; background: var(--surface); box-shadow: var(--shadow-sm); transition: transform 180ms cubic-bezier(0.33, 1, 0.68, 1); }
    .switch[aria-checked="true"] .switch-track { background: var(--brand); }
    .switch[aria-checked="true"] .switch-thumb { transform: translateX(18px); }
    .switch-state { min-width: 28px; color: var(--text-secondary); font-size: 12px; text-align: left; }

    /* Responsive breakpoints */
    @media (max-width: 768px) {
      :root { --gutter: 16px; }
      form { grid-template-columns: 1fr; gap: 16px; }
      .field-wide, .ssl-row, .form-error, .actions { grid-column: 1; }
      .ssl-row { align-items: flex-start; }
      .actions { position: sticky; z-index: 100; bottom: 0; margin: 0 calc(var(--gutter) * -1); padding: 12px var(--gutter); background: var(--surface); }
    }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { transition-duration: 1ms !important; animation-duration: 1ms !important; animation-iteration-count: 1 !important; }
    }
  </style>
</head>
<body>
  <header>
    <h1>${mode}</h1>
    <p>在一个面板内完成连接配置，保存后可从对象树测试连接。</p>
  </header>
  <main>
    <form id="connectionForm" novalidate>
      <div id="formError" class="form-error" role="alert"></div>
      <div class="field field-wide">
        <label for="name">连接名称</label>
        <input id="name" name="name" type="text" value="${escapeHtml(current?.name ?? '')}" maxlength="128" autocomplete="off" aria-describedby="nameError" autofocus>
        <span id="nameError" class="field-error"></span>
      </div>
      <div class="field">
        <label for="host">主机 / IP</label>
        <input id="host" name="host" type="text" value="${escapeHtml(current?.host ?? '127.0.0.1')}" maxlength="253" autocomplete="off" aria-describedby="hostError">
        <span id="hostError" class="field-error"></span>
      </div>
      <div class="field">
        <label for="port">端口</label>
        <input id="port" name="port" type="text" inputmode="numeric" value="${current?.port ?? 3306}" maxlength="5" autocomplete="off" aria-describedby="portError">
        <span id="portError" class="field-error"></span>
      </div>
      <div class="field">
        <label for="user">用户名</label>
        <input id="user" name="user" type="text" value="${escapeHtml(current?.user ?? 'root')}" maxlength="128" autocomplete="username" aria-describedby="userError">
        <span id="userError" class="field-error"></span>
      </div>
      <div class="field">
        <label for="password">密码</label>
        <input id="password" name="password" type="password" value="" maxlength="4096" autocomplete="new-password" aria-describedby="passwordHelp passwordError">
        <span id="passwordHelp" class="help">${passwordHelp}</span>
        <span id="passwordError" class="field-error"></span>
      </div>
      <div class="field field-wide">
        <label for="database">默认数据库（可选）</label>
        <input id="database" name="database" type="text" value="${escapeHtml(current?.database ?? '')}" maxlength="128" autocomplete="off" aria-describedby="databaseError">
        <span id="databaseError" class="field-error"></span>
      </div>
      <section class="ssl-row" aria-labelledby="sslLabel">
        <div class="ssl-copy">
          <div id="sslLabel" class="field-label">SSL</div>
          <p class="help">启用后使用驱动默认 TLS 校验，不自动接受自签名证书。</p>
        </div>
        <button id="sslSwitch" class="switch" type="button" role="switch" aria-checked="false" aria-labelledby="sslLabel sslState">
          <span class="switch-track" aria-hidden="true"><span class="switch-thumb"></span></span>
          <span id="sslState" class="switch-state">关闭</span>
        </button>
      </section>
      <div class="actions">
        <button id="cancel" type="button">取消</button>
        <button id="save" class="primary" type="submit">保存连接</button>
      </div>
    </form>
  </main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const initialState = ${initialState};
    const form = document.getElementById('connectionForm');
    const save = document.getElementById('save');
    const sslSwitch = document.getElementById('sslSwitch');
    const sslState = document.getElementById('sslState');
    const formError = document.getElementById('formError');
    const fields = ['name', 'host', 'port', 'user', 'password', 'database'];
    const controls = Object.fromEntries(fields.map((field) => [field, document.getElementById(field)]));
    let ssl = Boolean(initialState.ssl);

    const renderSsl = () => {
      sslSwitch.setAttribute('aria-checked', String(ssl));
      sslState.textContent = ssl ? '启用' : '关闭';
    };
    const setErrors = (errors) => {
      fields.forEach((field) => {
        const input = document.getElementById(field);
        const error = document.getElementById(field + 'Error');
        const message = typeof errors[field] === 'string' ? errors[field] : '';
        error.textContent = message;
        input.setAttribute('aria-invalid', String(Boolean(message)));
      });
      const formMessage = typeof errors.form === 'string' ? errors.form : '';
      formError.textContent = formMessage;
      formError.classList.toggle('visible', Boolean(formMessage));
      const firstInvalid = fields.find((field) => errors[field]);
      if (firstInvalid) document.getElementById(firstInvalid)?.focus();
    };
    const clientErrors = () => {
      const errors = {};
      if (!controls.name.value.trim()) errors.name = '请输入连接名称。';
      if (!controls.host.value.trim()) errors.host = '请输入主机名或 IP 地址。';
      if (!controls.user.value.trim()) errors.user = '请输入用户名。';
      const port = Number(controls.port.value);
      if (!Number.isInteger(port) || port < 1 || port > 65535) errors.port = '请输入 1–65535 之间的整数。';
      return errors;
    };

    fields.forEach((field) => {
      document.getElementById(field).addEventListener('input', () => {
        const input = document.getElementById(field);
        document.getElementById(field + 'Error').textContent = '';
        input.setAttribute('aria-invalid', 'false');
      });
    });
    sslSwitch.addEventListener('click', () => { ssl = !ssl; renderSsl(); });
    document.getElementById('cancel').addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const errors = clientErrors();
      setErrors(errors);
      if (Object.keys(errors).length > 0) return;
      save.disabled = true;
      save.textContent = '正在保存…';
      vscode.postMessage({
        type: 'submit',
        payload: {
          name: controls.name.value,
          host: controls.host.value,
          port: Number(controls.port.value),
          user: controls.user.value,
          password: controls.password.value,
          database: controls.database.value,
          ssl
        }
      });
    });
    window.addEventListener('message', (event) => {
      if (event.data?.type !== 'validation') return;
      save.disabled = false;
      save.textContent = '保存连接';
      setErrors(event.data.errors ?? { form: '保存失败，请检查输入。' });
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') vscode.postMessage({ type: 'cancel' });
    });
    renderSsl();
  </script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function isConnectionFormMessage(value: unknown): value is { type: 'submit' | 'cancel'; payload?: unknown } {
  if (typeof value !== 'object' || value === null || !('type' in value)) return false;
  const type = (value as { type?: unknown }).type;
  return type === 'submit' || type === 'cancel';
}
