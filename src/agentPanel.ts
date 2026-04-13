/**
 * agentPanel.ts — Panel Webview para configurar agentes y skills personalizados.
 *
 * Permite al usuario:
 *  - Ver el especialista activo
 *  - Cargar un AGENT.md personalizado (Browse)
 *  - Cargar un SKILLS.md personalizado (Browse)
 *  - Ver/resetear la configuración de rutas
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { ModelManager } from './modelManager';
import { ALL_SPECIALIST_IDS, getSpecialistDisplayName } from './agentRouter';
import { isSddActive, getSddState, STEP_NAMES, resetSdd, onStateChange } from './sddWorkflow';

const VIEW_ID = 'copilotLocal.agentPanel';

export class AgentPanelProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = VIEW_ID;

    private _view?: vscode.WebviewView;
    private readonly _disposables: vscode.Disposable[] = [];

    constructor(
        private readonly _extensionUri: vscode.Uri,
        _context: vscode.ExtensionContext,
        private readonly _manager?: ModelManager
    ) {
        // Refrescar el panel cuando el estado SDD cambia (pasos, colores)
        this._disposables.push(
            onStateChange(() => this._refreshPanel())
        );
    }

    dispose(): void {
        for (const d of this._disposables) { d.dispose(); }
    }

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): void {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri],
        };

        webviewView.webview.html = this._getHtmlContent(webviewView.webview);
        void this._pushLmsStatus();

        // Manejar mensajes desde el Webview
        webviewView.webview.onDidReceiveMessage(async (message: WebviewMessage) => {
            switch (message.command) {
                case 'browseAgent':
                    await this._addAgentFile();
                    break;
                case 'browseSkills':
                    await this._browseFile('skillsFilePath', 'Seleccionar SKILLS.md');
                    break;
                case 'clearAgent':
                    await this._clearPath('agentFilePath');
                    break;
                case 'removeAgent':
                    await this._removeAgentByIndex(message.index ?? 0);
                    break;
                case 'clearSkills':
                    await this._clearPath('skillsFilePath');
                    break;
                case 'openMcpConfig':
                    vscode.commands.executeCommand('copilotLocal.openMcpConfig');
                    break;
                case 'openLog':
                    vscode.commands.executeCommand('copilotLocal.openLog');
                    break;
                case 'setToolsCompact':
                    await vscode.workspace.getConfiguration('copilotLocal').update(
                        'toolsMode',
                        'compact',
                        vscode.ConfigurationTarget.Global
                    );
                    vscode.window.showInformationMessage('✅ toolsMode cambiado a "compact". Modelos con contexto < 48K funcionarán correctamente.');
                    this._refreshPanel();
                    break;
                case 'setConfig': {
                    const allowed = ['temperature', 'maxTokens', 'maxIterations', 'toolsMode', 'logLevel', 'activeSpecialist'];
                    if (message.key && allowed.includes(message.key)) {
                        await vscode.workspace.getConfiguration('copilotLocal').update(
                            message.key,
                            message.value,
                            vscode.ConfigurationTarget.Global
                        );
                    }
                    break;
                }
                case 'startSdd': {
                    const goal = await vscode.window.showInputBox({
                        prompt: 'Describe el objetivo o feature a desarrollar con SDD',
                        placeHolder: 'Ej: Sistema de gestión de usuarios con roles y JWT',
                        validateInput: v => ((v ?? '').trim().length < 5 ? 'Mínimo 5 caracteres' : null),
                    });
                    if (!goal) { break; }
                    await vscode.commands.executeCommand('workbench.action.chat.open', {
                        query: `@localai /sdd ${goal}`,
                    });
                    break;
                }
                case 'cancelSdd': {
                    resetSdd();
                    this._refreshPanel();
                    break;
                }
            }
        });

        // Actualizar el panel cuando cambia la configuración
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('copilotLocal')) {
                this._refreshPanel();
            }
        });
    }

    /**
     * Actualiza el contenido del panel con el estado actual.
     */
    private _refreshPanel(): void {
        if (this._view) {
            this._view.webview.html = this._getHtmlContent(this._view.webview);
            void this._pushLmsStatus();
        }
    }

    /**
     * Consulta el estado de LM Studio de forma async y lo envía al webview via postMessage.
     */
    private async _pushLmsStatus(): Promise<void> {
        if (!this._view || !this._manager) { return; }
        try {
            const status = await this._manager.getBackendStatus();
            void this._view.webview.postMessage({ command: 'lmsStatus', status });
        } catch {
            void this._view.webview.postMessage({ command: 'lmsStatus', status: { available: false, url: '', modelCount: 0 } });
        }
    }

    /**
     * Abre diálogo para agregar un nuevo archivo .md al array de agentFilePath.
     */
    private async _addAgentFile(): Promise<void> {
        const result = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: true,
            filters: { 'Markdown': ['md'] },
            title: 'Agregar AGENT.md personalizado',
        });

        if (result && result.length > 0) {
            const current = vscode.workspace.getConfiguration('copilotLocal').get<string[]>('agentFilePath') ?? [];
            const nuevas = result.map(u => u.fsPath).filter(p => !current.includes(p));
            if (nuevas.length === 0) { return; }
            await vscode.workspace.getConfiguration('copilotLocal').update(
                'agentFilePath',
                [...current, ...nuevas],
                vscode.ConfigurationTarget.Global
            );
            this._refreshPanel();
            vscode.window.showInformationMessage(`✅ ${nuevas.length} archivo(s) agregado(s).`);
        }
    }

    /**
     * Elimina un archivo del array de agentFilePath por índice.
     */
    private async _removeAgentByIndex(index: number): Promise<void> {
        const current = vscode.workspace.getConfiguration('copilotLocal').get<string[]>('agentFilePath') ?? [];
        if (index < 0 || index >= current.length) { return; }
        const updated = current.filter((_, i) => i !== index);
        await vscode.workspace.getConfiguration('copilotLocal').update(
            'agentFilePath',
            updated,
            vscode.ConfigurationTarget.Global
        );
        this._refreshPanel();
    }

    /**
     * Abre un diálogo para seleccionar un archivo .md y guarda la ruta en la configuración.
     */
    private async _browseFile(configKey: string, title: string): Promise<void> {
        const result = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            filters: { 'Markdown': ['md'] },
            title,
        });

        if (result && result.length > 0) {
            const selectedPath = result[0].fsPath;
            await vscode.workspace.getConfiguration('copilotLocal').update(
                configKey,
                selectedPath,
                vscode.ConfigurationTarget.Global
            );
            this._refreshPanel();
            vscode.window.showInformationMessage(`✅ Archivo configurado: ${path.basename(selectedPath)}`);
        }
    }

    /**
     * Limpia la ruta configurada para un archivo.
     */
    private async _clearPath(configKey: string): Promise<void> {
        await vscode.workspace.getConfiguration('copilotLocal').update(
            configKey,
            undefined,
            vscode.ConfigurationTarget.Global
        );
        this._refreshPanel();
    }

    private _getHtmlContent(_webview: vscode.Webview): string {
        const config = vscode.workspace.getConfiguration('copilotLocal');
        const agentPaths = config.get<string[]>('agentFilePath') ?? [];
        const skillsPath = config.get<string>('skillsFilePath') ?? '';
        const activeSpecialist = config.get<string>('activeSpecialist') ?? 'orchestrator';
        const toolsMode = config.get<string>('toolsMode') ?? 'compact';
        const showToolsWarning = toolsMode === 'full';
        const temperature = config.get<number>('temperature') ?? 0.7;
        const maxTokens = config.get<number>('maxTokens') ?? 4096;
        const maxIterations = config.get<number>('maxIterations') ?? 20;
        const logLevel = config.get<string>('logLevel') ?? 'INFO';

        // Opciones del select de especialista
        const ALL_SPECIALIST_OPTIONS = ['orchestrator', ...ALL_SPECIALIST_IDS, 'sdd'];
        const specialistOptionsHtml = ALL_SPECIALIST_OPTIONS.map(id => {
            const label = id === 'orchestrator' ? 'Auto (Orquestador)' : (getSpecialistDisplayName as (id: string) => string)(id);
            const sel = activeSpecialist === id ? 'selected' : '';
            return `<option value="${id}" ${sel}>${escapeHtml(label)}</option>`;
        }).join('');

        // Estado SDD para el panel
        const sddActive = isSddActive();
        const sddState = getSddState();
        const STEP_SEQUENCE = ['init','explore','design','spec','propose','tasks','apply','verify','archive'];
        const sddStepIdx = STEP_SEQUENCE.indexOf(sddState.step) + 1;
        const sddStepName = sddActive ? (STEP_NAMES[sddState.step] ?? sddState.step) : '';

        const agentListHtml = agentPaths.length === 0
            ? '<div class="field-value hint">(ninguno \u2014 se usan los bundleados)</div>'
            : agentPaths.map((p, i) => [
                '<div class="agent-item">',
                `<span class="agent-name" title="${escapeHtml(p)}">${escapeHtml(path.basename(p))}</span>`,
                `<button class="btn-remove" data-action="removeAgent" data-index="${i}" title="Quitar">&#x2715;</button>`,
                '</div>',
            ].join('')).join('');

        const skillsFileName = skillsPath ? path.basename(skillsPath) : '(sin skills adicionales)';

        const nonce = getNonce();

        return /* html */ `<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Local AI — Agentes</title>
    <style nonce="${nonce}">
        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background: var(--vscode-sideBar-background);
            padding: 8px;
            margin: 0;
        }
        h3 {
            font-size: 11px;
            text-transform: uppercase;
            letter-spacing: 0.08em;
            color: var(--vscode-sideBarSectionHeader-foreground);
            margin: 12px 0 6px 0;
        }
        .badge {
            display: inline-block;
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            border-radius: 10px;
            padding: 1px 8px;
            font-size: 11px;
            margin-bottom: 8px;
        }
        .field {
            margin-bottom: 10px;
        }
        .field-label {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 2px;
        }
        .field-value {
            font-size: 12px;
            color: var(--vscode-foreground);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            max-width: 100%;
        }
        .btn-row {
            display: flex;
            gap: 4px;
            margin-top: 4px;
        }
        button {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: none;
            border-radius: 2px;
            padding: 3px 8px;
            font-size: 11px;
            cursor: pointer;
            flex: 1;
        }
        button:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }
        button.primary {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        button.primary:hover {
            background: var(--vscode-button-hoverBackground);
        }
        .separator {
            border: none;
            border-top: 1px solid var(--vscode-widget-border);
            margin: 12px 0;
        }
        .hint {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            font-style: italic;
        }
        .agent-item {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 2px 0;
        }
        .agent-name {
            font-size: 12px;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            flex: 1;
        }
        .btn-remove {
            background: transparent;
            color: var(--vscode-errorForeground);
            border: none;
            cursor: pointer;
            font-size: 13px;
            padding: 0 4px;
            flex: 0;
        }
        .btn-remove:hover {
            background: var(--vscode-inputValidation-errorBackground);
        }
        .banner-warn {
            display: flex;
            align-items: flex-start;
            gap: 6px;
            background: var(--vscode-inputValidation-warningBackground);
            border: 1px solid var(--vscode-inputValidation-warningBorder);
            border-radius: 3px;
            padding: 6px 8px;
            margin-bottom: 10px;
            font-size: 11px;
            line-height: 1.4;
        }
        .banner-warn .warn-icon { flex-shrink: 0; }
        .banner-warn .warn-text { flex: 1; }
        .banner-warn button {
            flex: 0;
            margin-top: 4px;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            font-size: 10px;
            padding: 2px 6px;
        }
        .banner-status {
            display: flex;
            align-items: center;
            gap: 6px;
            border-radius: 3px;
            padding: 5px 8px;
            margin-bottom: 8px;
            font-size: 11px;
            border: 1px solid var(--vscode-widget-border);
        }
        .banner-status.online  { border-color: var(--vscode-testing-iconPassed, #388a34); }
        .banner-status.offline { background: var(--vscode-inputValidation-errorBackground); border-color: var(--vscode-inputValidation-errorBorder); }
        .banner-status.checking { opacity: 0.6; }
        .status-model { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 150px; }
        .config-row {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 6px;
            margin-bottom: 8px;
        }
        .config-row label {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            flex: 1;
            white-space: nowrap;
        }
        .config-row input[type=number],
        .config-row select {
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border, transparent);
            border-radius: 2px;
            padding: 2px 4px;
            font-size: 11px;
            width: 80px;
            text-align: right;
        }
        .config-row select { width: 100px; text-align: left; }
        .sdd-status {
            font-size: 12px;
            font-weight: 600;
            color: var(--vscode-charts-blue);
            margin-bottom: 8px;
            padding: 4px 0;
        }
    </style>
</head>
<body>
    <div id="lms-status" class="banner-status checking">&#x23F3; Verificando LM Studio&#x2026;</div>
    ${showToolsWarning ? `<div class="banner-warn">
        <span class="warn-icon">&#x26A0;&#xFE0F;</span>
        <div class="warn-text">
            <strong>toolsMode &quot;full&quot;</strong> inyecta JSON schemas completos y puede causar
            <code>n_keep &gt;= n_ctx</code> en modelos con contexto &lt; 48K.
            <div><button data-action="setToolsCompact" style="margin-top:4px">Cambiar a compact</button></div>
        </div>
    </div>` : ''}
    <h3>Especialista Activo</h3>
    <div class="config-row">
        <label for="cfg-specialist">Agente</label>
        <select id="cfg-specialist" data-config="activeSpecialist" style="width:150px">
            ${specialistOptionsHtml}
        </select>
    </div>
    <p class="hint">"Auto" detecta por contexto. Elige un especialista para fijarlo en todas las conversaciones.</p>

    <hr class="separator">

    <h3>&#x1F4CB; SDD Workflow</h3>
    ${sddActive
        ? `<div class="sdd-status">&#x25B6;&#xFE0F; ${escapeHtml(sddStepName)} (${sddStepIdx}/9)</div>
           <button data-action="cancelSdd">&#x23F9;&#xFE0F; Cancelar flujo SDD</button>`
        : `<p class="hint">Desarrollo guiado paso a paso: Explore &#x2192; Design &#x2192; Spec &#x2192; Tasks &#x2192; Apply &#x2192; Verify.</p>
           <button class="primary" data-action="startSdd">&#x25B6; Iniciar SDD Workflow</button>`
    }

    <hr class="separator">

    <h3>AGENT.md (custom)</h3>
    <div class="field">
        <div class="field-label">Instrucciones inyectadas en TODOS los especialistas:</div>
        ${agentListHtml}
        <div class="btn-row" style="margin-top:6px">
            <button class="primary" data-action="browseAgent">&#43; Agregar archivo</button>
            ${agentPaths.length > 0 ? '<button data-action="clearAgent">&#x2715; Limpiar todos</button>' : ''}
        </div>
    </div>

    <h3>SKILLS.md</h3>
    <div class="field">
        <div class="field-label">Skills adicionales:</div>
        <div class="field-value" title="${escapeHtml(skillsPath)}">${escapeHtml(skillsFileName)}</div>
        <div class="btn-row">
            <button class="primary" data-action="browseSkills">&#128194; Browse</button>
            ${skillsPath ? '<button data-action="clearSkills">&#x2715; Limpiar</button>' : ''}
        </div>
    </div>

    <h3>Configuraci&#x00F3;n</h3>
    <div class="config-row">
        <label for="cfg-temperature">Temperatura</label>
        <input id="cfg-temperature" type="number" min="0" max="2" step="0.05"
               value="${temperature}" data-config="temperature">
    </div>
    <div class="config-row">
        <label for="cfg-maxTokens">Max Tokens</label>
        <input id="cfg-maxTokens" type="number" min="256" max="131072" step="256"
               value="${maxTokens}" data-config="maxTokens">
    </div>
    <div class="config-row">
        <label for="cfg-maxIterations">Max Iteraciones</label>
        <input id="cfg-maxIterations" type="number" min="1" max="50" step="1"
               value="${maxIterations}" data-config="maxIterations">
    </div>
    <div class="config-row">
        <label for="cfg-toolsMode">Tools Mode</label>
        <select id="cfg-toolsMode" data-config="toolsMode">
            <option value="compact" ${toolsMode === 'compact' ? 'selected' : ''}>compact</option>
            <option value="full" ${toolsMode === 'full' ? 'selected' : ''}>full</option>
            <option value="off" ${toolsMode === 'off' ? 'selected' : ''}>off</option>
        </select>
    </div>
    <div class="config-row">
        <label for="cfg-logLevel">Log Level</label>
        <select id="cfg-logLevel" data-config="logLevel">
            <option value="DEBUG" ${logLevel === 'DEBUG' ? 'selected' : ''}>DEBUG</option>
            <option value="INFO"  ${logLevel === 'INFO'  ? 'selected' : ''}>INFO</option>
            <option value="WARN"  ${logLevel === 'WARN'  ? 'selected' : ''}>WARN</option>
            <option value="ERROR" ${logLevel === 'ERROR' ? 'selected' : ''}>ERROR</option>
        </select>
    </div>

    <hr class="separator">
    <button data-action="openMcpConfig">&#9881;&#65039; Abrir .mcp.json</button>
    <p class="hint">Configura ia-orquestador e ia-recuerdo para habilidades avanzadas.</p>

    <hr class="separator">

    <h3>Diagn&#x00F3;stico</h3>
    <button data-action="openLog">&#128196; Abrir archivo de log</button>
    <p class="hint">Archivo persistente con diagn&#x00F3;stico detallado de tokens, presupuesto y errores.</p>

    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        document.addEventListener('click', function(e) {
            const btn = e.target.closest('[data-action]');
            if (!btn) { return; }
            const action = btn.getAttribute('data-action');
            if (action === 'browseAgent')         { vscode.postMessage({ command: 'browseAgent' }); }
            else if (action === 'clearAgent')      { vscode.postMessage({ command: 'clearAgent' }); }
            else if (action === 'browseSkills')    { vscode.postMessage({ command: 'browseSkills' }); }
            else if (action === 'clearSkills')     { vscode.postMessage({ command: 'clearSkills' }); }
            else if (action === 'openMcpConfig')   { vscode.postMessage({ command: 'openMcpConfig' }); }
            else if (action === 'openLog')           { vscode.postMessage({ command: 'openLog' }); }
            else if (action === 'setToolsCompact') { vscode.postMessage({ command: 'setToolsCompact' }); }
            else if (action === 'removeAgent') {
                vscode.postMessage({ command: 'removeAgent', index: parseInt(btn.getAttribute('data-index'), 10) });
            }
            else if (action === 'startSdd')  { vscode.postMessage({ command: 'startSdd' }); }
            else if (action === 'cancelSdd') { vscode.postMessage({ command: 'cancelSdd' }); }
        });
        // Cambios en inputs/selects de configuración — guardar al cambiar
        document.querySelectorAll('[data-config]').forEach(function(el) {
            el.addEventListener('change', function() {
                const key = el.getAttribute('data-config');
                const val = el.tagName === 'SELECT' ? el.value : parseFloat(el.value);
                vscode.postMessage({ command: 'setConfig', key: key, value: val });
            });
        });
        // Recibir estado LM Studio desde la extensi&#x00F3;n v&#x00ED;a postMessage
        window.addEventListener('message', function(event) {
            const msg = event.data;
            if (msg.command !== 'lmsStatus') { return; }
            const el = document.getElementById('lms-status');
            if (!el) { return; }
            if (msg.status && msg.status.available) {
                const n = msg.status.modelCount;
                const models = msg.status.models;
                const modelName = (models && models.length > 0) ? models[0].name : 'LM Studio';
                el.className = 'banner-status online';
                el.innerHTML = '&#x2705; <span class="status-model">' + modelName + '</span>&nbsp;&middot;&nbsp;' + n + '&nbsp;modelo' + (n !== 1 ? 's' : '');
            } else {
                el.className = 'banner-status offline';
                el.innerHTML = '&#x274C; LM Studio no disponible';
            }
        });
    </script>
</body>
</html>`;
    }
}

interface WebviewMessage {
    command: string;
    index?: number;
    key?: string;
    value?: unknown;
}

function getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}

function escapeHtml(str: string): string {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
