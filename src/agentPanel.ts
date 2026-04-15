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
import { ModelManager, BackendStatus } from './modelManager';
import { ALL_SPECIALIST_IDS, getSpecialistDisplayName } from './agentRouter';
import { isSddActive, getSddState, STEP_NAMES, resetSdd, onStateChange } from './sddWorkflow';
import { StatsTracker } from './statsTracker';

const VIEW_ID = 'copilotLocal.agentPanel';

export class AgentPanelProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = VIEW_ID;

    private _view?: vscode.WebviewView;
    private readonly _disposables: vscode.Disposable[] = [];
    private _cachedStatus: BackendStatus | null = null;

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
                case 'resetStats': {
                    StatsTracker.instance.reset();
                    this._refreshPanel();
                    break;
                }
            }
        });

        // Actualizar el panel cuando cambia la configuración
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('copilotLocal')) {
                if (e.affectsConfiguration('copilotLocal.lmStudioUrl')) {
                    // URL cambió: invalidar cache y re-verificar
                    this._cachedStatus = null;
                    void this._pushLmsStatus();
                } else {
                    this._refreshPanel();
                }
            }
        });
    }

    /**
     * Actualiza el contenido del panel con el estado actual (usa el status cacheado).
     */
    private _refreshPanel(): void {
        if (this._view) {
            this._view.webview.html = this._getHtmlContent(this._view.webview);
        }
    }

    /**
     * Construye el banner HTML para el estado de LM Studio a partir del cache.
     */
    private _getStatusBannerHtml(): string {
        const st = this._cachedStatus;
        if (!st) {
            return `<div id="lms-status" class="status-chip checking"><span class="dot"></span><span class="status-text">&#x23F3; Verificando LM Studio&hellip;</span></div>`;
        }
        if (st.available) {
            const n = st.modelCount;
            return `<div id="lms-status" class="status-chip online"><span class="dot"></span><span class="status-text">LM Studio &mdash; ${n}&nbsp;modelo${n !== 1 ? 's' : ''}</span></div>`;
        }
        return `<div id="lms-status" class="status-chip offline"><span class="dot"></span><span class="status-text">LM Studio no disponible</span></div>`;
    }

    /**
     * Consulta el estado de LM Studio, cachea el resultado y re-renderiza el HTML.
     * No usa postMessage — el estado se bake directamente en el HTML para evitar
     * race conditions cuando el webview se recarga entre la consulta y la respuesta.
     */
    private async _pushLmsStatus(): Promise<void> {
        if (!this._manager) { return; }
        try {
            this._cachedStatus = await this._manager.getBackendStatus();
        } catch {
            this._cachedStatus = { available: false, url: '', modelCount: 0 };
        }
        if (this._view) {
            this._view.webview.html = this._getHtmlContent(this._view.webview);
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

        const skillsFileName = skillsPath ? path.basename(skillsPath) : '(sin skills adicionales)';

        // === Stats snapshot ===
        let stats = { totalRequests: 0, totalTokensIn: 0, totalTokensOut: 0, totalErrors: 0, totalDurationMs: 0, lastRequestAt: 0, lastModel: '' };
        try { stats = StatsTracker.instance.get(); } catch { /* no init yet */ }
        const successRate = stats.totalRequests > 0
            ? Math.round(((stats.totalRequests - stats.totalErrors) / stats.totalRequests) * 100)
            : 100;
        const avgDur = StatsTracker.formatAvgDuration(stats.totalDurationMs, stats.totalRequests);
        const tokIn  = StatsTracker.formatTokens(stats.totalTokensIn);
        const tokOut = StatsTracker.formatTokens(stats.totalTokensOut);
        const relTime = StatsTracker.formatRelativeTime(stats.lastRequestAt);

        const nonce = getNonce();

        // Pre-compute SDD stepper (evita IIFE dentro del template literal)
        const STEP_SEQ2  = ['init','explore','design','spec','propose','tasks','apply','verify','archive'];
        const STEP_ABBR  = ['IN','EX','DE','SP','PR','TA','AP','VE','AR'];
        const sddStepper = STEP_ABBR.map((abbr, i) => {
            const idx    = i + 1;
            const done   = sddActive && idx < sddStepIdx;
            const active = sddActive && idx === sddStepIdx;
            const cls    = done ? ' done' : active ? ' active' : '';
            const lCls   = done ? ' done' : '';
            const lbl    = STEP_NAMES[STEP_SEQ2[i] as keyof typeof STEP_NAMES] ?? STEP_SEQ2[i];
            const line   = i < STEP_ABBR.length - 1 ? `<div class="s-line${lCls}"></div>` : '';
            return `<div class="s-dot${cls}" title="${escapeHtml(lbl)}">${abbr}</div>${line}`;
        }).join('');

        const sddBody = sddActive
            ? `<div class="sdd-stepper">${sddStepper}</div>
               <div class="sdd-lbl"><span>&#x25B6; ${escapeHtml(sddStepName)}</span><span class="sdd-count">${sddStepIdx}&thinsp;/&thinsp;9</span></div>
               <div class="prog-track"><div class="prog-fill" style="width:${Math.round(sddStepIdx/9*100)}%"></div></div>
               <div class="btn-bar" style="margin-top:8px">
                   <button class="ibtn xl danger" data-action="cancelSdd" title="Cancelar flujo SDD">&#x23F9;&ensp;Cancelar SDD</button>
               </div>`
            : `<div class="sdd-stepper">${sddStepper}</div>
               <p class="hint" style="margin:5px 0 8px">Explore&#x2192;Design&#x2192;Spec&#x2192;Propose&#x2192;Tasks&#x2192;Apply&#x2192;Verify&#x2192;Archive</p>
               <button class="ibtn xl primary" data-action="startSdd" title="Iniciar SDD Workflow">&#x25B6;&ensp;Iniciar SDD Workflow</button>`;

        const agentChips = agentPaths.length === 0
            ? `<div class="empty-hint">Ninguno &mdash; se usan los bundleados</div>`
            : `<div class="chip-list">${agentPaths.map((p, i) =>
                `<div class="chip"><span class="chip-name" title="${escapeHtml(p)}">${escapeHtml(path.basename(p))}</span><button class="chip-x" data-action="removeAgent" data-index="${i}" title="Quitar ${escapeHtml(path.basename(p))}">&#x2715;</button></div>`
              ).join('')}</div>`;

        return /* html */ `<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'none'; font-src https://fonts.gstatic.com; style-src 'nonce-${nonce}' https://fonts.googleapis.com; script-src 'nonce-${nonce}';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Local AI</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
    <style nonce="${nonce}">
        /* ── Reset ───────────────────────────────────────────────────── */
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

        /* ── Design tokens ───────────────────────────────────────────── */
        :root {
            --p:   #7c3aed;
            --p2:  #a855f7;
            --c:   #06b6d4;
            --c2:  #22d3ee;
            /* Colores base: hex explícito para evitar tintes del tema VS Code */
            --bg:  #0a0a15;
            --s1:  #111120;
            --s2:  #181828;
            --bd:  #2d2d4e;
            --tx:  #dde1f0;
            --td:  #6272a4;
            --ok:  #22c55e;
            --er:  #ef4444;
            --wn:  #f59e0b;
            --r:   4px;
            --rs:  3px;
        }

        body {
            font-family: 'Inter', system-ui, sans-serif;
            font-size: 12px;
            line-height: 1.5;
            color: var(--tx);
            background: var(--bg);
            padding: 8px 8px 32px;
            -webkit-font-smoothing: antialiased;
        }

        /* ── Animations ───────────────────────────────────────────────── */
        @keyframes spin-cw   { to { transform: rotate(360deg);  } }
        @keyframes spin-ccw  { to { transform: rotate(-360deg); } }
        @keyframes dot-pulse {
            0%, 100% { box-shadow: 0 0 0 0 rgba(34,197,94,.6); }
            60%      { box-shadow: 0 0 0 4px rgba(34,197,94,0); }
        }
        @keyframes shimmer {
            0%   { background-position: -200% center; }
            100% { background-position:  200% center; }
        }
        @keyframes eye-blink {
            0%,88%,100% { transform: scaleY(1); }
            93%         { transform: scaleY(.08); }
        }
        @keyframes glow {
            0%,100% { filter: drop-shadow(0 0 3px var(--p)); }
            50%     { filter: drop-shadow(0 0 9px var(--p2)); }
        }
        @keyframes scan {
            0%         { top: 22%; opacity: 0; }
            8%,92%     { opacity: .8; }
            100%       { top: 78%; opacity: 0; }
        }
        @keyframes fade-up {
            from { opacity: 0; transform: translateY(6px); }
            to   { opacity: 1; transform: translateY(0); }
        }

        /* ── AI Avatar ────────────────────────────────────────────────── */
        .ai-hero {
            display: flex;
            flex-direction: column;
            align-items: center;
            padding: 14px 0 6px;
            animation: fade-up .4s ease both;
        }
        .ai-wrap {
            position: relative;
            width: 76px; height: 76px;
            margin-bottom: 7px;
        }
        .ring-outer {
            position: absolute; inset: 0;
            animation: spin-cw 14s linear infinite;
            transform-origin: center;
        }
        .ring-inner {
            position: absolute; inset: 10px;
            animation: spin-ccw 9s linear infinite;
            transform-origin: center;
        }
        .face-svg {
            position: absolute; inset: 18px;
            animation: glow 3s ease-in-out infinite;
        }
        .eye-l, .eye-r {
            animation: eye-blink 4.5s ease-in-out infinite;
            transform-origin: center;
        }
        .eye-r { animation-delay: .12s; }
        .scan-line {
            position: absolute;
            left: 14%; right: 14%;
            height: 1.5px;
            background: linear-gradient(90deg, transparent, var(--c2), transparent);
            animation: scan 2.8s ease-in-out infinite;
            border-radius: 1px;
        }
        .ai-name {
            font-size: 13px;
            font-weight: 600;
            letter-spacing: .1em;
            text-transform: uppercase;
            background: linear-gradient(90deg, var(--p2), var(--c2));
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
        }
        .ai-sub {
            font-size: 9px;
            color: var(--td);
            letter-spacing: .12em;
            text-transform: uppercase;
            margin-top: 1px;
        }

        /* ── Status chip ──────────────────────────────────────────────── */
        .status-chip {
            display: flex;
            align-items: center;
            gap: 7px;
            border-radius: var(--rs);
            padding: 5px 10px;
            font-size: 11px;
            font-weight: 500;
            margin-bottom: 8px;
            border: 1px solid var(--bd);
            background: var(--s1);
        }
        .dot {
            width: 7px; height: 7px;
            border-radius: 50%;
            flex-shrink: 0;
        }
        .status-chip.online  { border-color: var(--ok); }
        .status-chip.online  .dot { background: var(--ok); animation: dot-pulse 2.2s ease infinite; }
        .status-chip.offline { border-color: var(--er); }
        .status-chip.offline .dot { background: var(--er); }
        .status-chip.checking { opacity: .55; }
        .status-chip.checking .dot { background: var(--td); }
        .status-text { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

        /* ── Processing bar ──────────────────────────────────────────── */
        .proc-bar {
            height: 2px;
            background: linear-gradient(90deg, transparent, var(--p), var(--c2), var(--p), transparent);
            background-size: 200% 100%;
            animation: shimmer .9s linear infinite;
            border-radius: 1px;
            margin-bottom: 8px;
        }

        /* ── Warn banner ─────────────────────────────────────────────── */
        .warn-banner {
            display: flex; align-items: flex-start; gap: 8px;
            background: rgba(245,158,11,.08);
            border: 1px solid rgba(245,158,11,.35);
            border-radius: var(--r); padding: 8px 10px; margin-bottom: 8px;
            font-size: 11px; line-height: 1.5;
        }

        /* ── Cards ───────────────────────────────────────────────────── */
        .card {
            background: #111120;
            border: 1px solid #2d2d4e;
            border-radius: var(--r);
            padding: 12px 12px 14px;
            margin-bottom: 8px;
            animation: fade-up .3s ease both;
        }
        .card-hdr {
            display: flex; align-items: center; gap: 6px;
            margin-bottom: 8px;
        }
        .card-ico {
            width: 18px; height: 18px;
            display: flex; align-items: center; justify-content: center;
            border-radius: var(--rs);
            background: linear-gradient(135deg, var(--p), var(--c));
            font-size: 10px; flex-shrink: 0;
        }
        .card-ttl {
            font-size: 10px; font-weight: 600;
            text-transform: uppercase; letter-spacing: .08em;
            color: var(--td);
            flex: 1;
        }

        /* ── Specialist select ──────────────────────────────────────── */
        .spec-sel {
            width: 100%;
            background: #181828; color: #dde1f0;
            border: 1px solid #2d2d4e; border-radius: var(--rs);
            padding: 6px 8px;
            font-family: 'Inter', sans-serif; font-size: 12px;
            outline: none; transition: border-color .15s;
            color-scheme: dark;
            appearance: auto;
        }
        .spec-sel:focus { border-color: var(--p); }
        .spec-sel option { background: #181828; color: #dde1f0; }

        /* ── SDD stepper ────────────────────────────────────────────── */
        .sdd-stepper {
            display: flex; align-items: center;
            gap: 0; margin: 10px 0 8px;
        }
        .s-dot {
            width: 26px; height: 26px; border-radius: 50%;
            display: flex; align-items: center; justify-content: center;
            font-size: 7px; font-weight: 700; flex-shrink: 0;
            border: 1.5px solid #2d2d4e;
            background: #181828; color: #6272a4;
            font-family: 'JetBrains Mono', monospace;
            transition: all .3s;
            cursor: default;
            user-select: none;
            letter-spacing: -.5px;
        }
        .s-dot.done   { background: var(--p); border-color: var(--p); color: #fff; }
        .s-dot.active { background: transparent; border-color: var(--c); color: var(--c);
                        box-shadow: 0 0 8px rgba(6,182,212,.45); }
        .s-line {
            flex: 1; height: 1px;
            background: #2d2d4e; transition: background .3s;
        }
        .s-line.done { background: var(--p); }
        .sdd-lbl {
            display: flex; justify-content: space-between;
            font-size: 11px; font-weight: 500;
            color: var(--c); margin-top: 3px;
        }
        .sdd-count {
            font-family: 'JetBrains Mono', monospace;
            font-size: 10px; color: var(--td);
        }
        .prog-track {
            height: 3px; background: #181828;
            border-radius: 2px; overflow: hidden; margin-top: 8px;
        }
        .prog-fill {
            height: 100%;
            background: linear-gradient(90deg, var(--p), var(--c2), var(--p));
            background-size: 200% 100%;
            animation: shimmer 2s linear infinite;
            border-radius: 2px;
        }

        /* ── Chips ───────────────────────────────────────────────────── */
        .chip-list { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 5px; }
        .chip {
            display: inline-flex; align-items: center; gap: 3px;
            background: rgba(124,58,237,.12);
            border: 1px solid rgba(124,58,237,.4);
            border-radius: 3px; padding: 2px 6px 2px 5px;
            font-size: 10px; font-weight: 500; color: var(--p2);
            max-width: 160px;
        }
        .chip-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .chip-x {
            cursor: pointer; border: none; background: transparent;
            color: var(--p2); font-size: 12px; padding: 0; opacity: .6;
        }
        .chip-x:hover { opacity: 1; }
        .empty-hint { font-size: 10px; color: var(--td); padding-bottom: 4px; }

        /* ── Config grid (2 col, like stats) ────────────────────────── */
        .cfg-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 5px;
        }
        .cfg-tile {
            background: #181828;
            border-radius: var(--rs);
            padding: 8px 9px;
        }
        .cfg-tile-lbl {
            display: block; font-size: 9px;
            text-transform: uppercase; letter-spacing: .05em;
            color: var(--td); margin-bottom: 3px;
        }
        .cfg-tile input,
        .cfg-tile select {
            width: 100%;
            background: transparent; color: #dde1f0;
            border: none; border-bottom: 1px solid #2d2d4e;
            font-family: 'JetBrains Mono', monospace;
            font-size: 12px; font-weight: 500;
            outline: none; padding: 2px 0;
            color-scheme: dark;
        }
        .cfg-tile select option { background: #181828; color: #dde1f0; }
        /* Esconder flechas nativas de number input */
        .cfg-tile input[type=number]::-webkit-inner-spin-button,
        .cfg-tile input[type=number]::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
        .cfg-tile input[type=number] { appearance: textfield; }
        .cfg-tile input:focus,
        .cfg-tile select:focus { border-color: var(--p); }
        .cfg-span2 { grid-column: span 2; }

        /* ── Stats grid ─────────────────────────────────────────────── */
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 5px; margin-bottom: 6px;
        }
        .stat-tile {
            background: #181828;
            border-radius: var(--rs);
            padding: 7px 4px; text-align: center;
        }
        .stat-val {
            display: block;
            font-family: 'JetBrains Mono', monospace;
            font-size: 14px; font-weight: 500;
            color: var(--c2); line-height: 1.1;
        }
        .stat-val.er { color: var(--er); }
        .stat-lbl {
            display: block; font-size: 9px;
            text-transform: uppercase; letter-spacing: .05em;
            color: var(--td); margin-top: 2px;
        }
        .stats-meta {
            font-size: 10px; color: var(--td);
            margin-bottom: 5px;
            font-family: 'JetBrains Mono', monospace;
        }

        /* ── Icon buttons ────────────────────────────────────────────── */
        .ibtn {
            cursor: pointer;
            border: 1px solid #2d2d4e;
            border-radius: var(--rs);
            width: 26px; height: 26px;
            display: inline-flex; align-items: center; justify-content: center;
            font-size: 13px; flex-shrink: 0;
            background: #181828; color: #6272a4;
            transition: border-color .15s, color .15s, background .15s;
        }
        .ibtn:hover { border-color: var(--p); color: var(--tx); background: rgba(124,58,237,.15); }
        .ibtn.primary { background: var(--p); border-color: var(--p); color: #fff; }
        .ibtn.primary:hover { background: var(--p2); border-color: var(--p2); }
        .ibtn.danger  { color: var(--er); border-color: rgba(239,68,68,.3); background: transparent; }
        .ibtn.danger:hover { background: rgba(239,68,68,.12); border-color: var(--er); }
        /* xl = full-width labeled button */
        .ibtn.xl {
            width: 100%; height: 30px; gap: 6px;
            font-size: 11px; font-weight: 500; font-family: 'Inter', sans-serif;
        }
        .ibtn.xl.primary { }
        .ibtn.xl.danger  { border-color: rgba(239,68,68,.4); }
        /* toolbar row */
        .ibar { display: flex; gap: 5px; margin-top: 6px; }
        .ibar.stretch .ibtn { flex: 1; }

        .hint { font-size: 10px; color: var(--td); margin-top: 4px; line-height: 1.4; }
    </style>
</head>
<body>

    <!-- AI Agent Avatar -->
    <div class="ai-hero">
        <div class="ai-wrap">
            <svg class="ring-outer" viewBox="0 0 76 76" xmlns="http://www.w3.org/2000/svg">
                <circle cx="38" cy="38" r="35" fill="none" stroke="#7c3aed" stroke-width=".7" stroke-dasharray="5 3" opacity=".45"/>
            </svg>
            <svg class="ring-inner" viewBox="0 0 56 56" xmlns="http://www.w3.org/2000/svg">
                <circle cx="28" cy="28" r="25" fill="none" stroke="#06b6d4" stroke-width=".7" stroke-dasharray="3 5" opacity=".45"/>
            </svg>
            <svg class="face-svg" viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg" overflow="visible">
                <rect x="1" y="1" width="38" height="38" rx="4" fill="rgba(124,58,237,.1)" stroke="#7c3aed" stroke-width="1.2"/>
                <rect class="eye-l" x="4"  y="13" width="13" height="7" rx="2" fill="#06b6d4" opacity=".9"/>
                <rect class="eye-r" x="23" y="13" width="13" height="7" rx="2" fill="#06b6d4" opacity=".9"/>
                <rect x="6" y="26" width="28" height="2" rx="1" fill="#7c3aed" opacity=".7"/>
                <rect x="6" y="30" width="20" height="1.5" rx="1" fill="#7c3aed" opacity=".4"/>
                <line x1="0" y1="17" x2="1" y2="17" stroke="#06b6d4" stroke-width="1.2"/>
                <line x1="0" y1="21" x2="1" y2="21" stroke="#06b6d4" stroke-width="1.2"/>
                <line x1="39" y1="17" x2="40" y2="17" stroke="#06b6d4" stroke-width="1.2"/>
                <line x1="39" y1="21" x2="40" y2="21" stroke="#06b6d4" stroke-width="1.2"/>
            </svg>
            <div class="scan-line"></div>
        </div>
        <span class="ai-name">Local AI</span>
        <span class="ai-sub">LM Studio &middot; Agent Mode</span>
    </div>

    ${this._getStatusBannerHtml()}
    ${(this._cachedStatus === null) ? '<div class="proc-bar"></div>' : ''}

    ${showToolsWarning ? `
    <div class="warn-banner">
        <span style="flex-shrink:0;font-size:14px">&#x26A0;</span>
        <div>
            <strong>toolsMode "full"</strong> puede causar <code>n_keep &gt;= n_ctx</code> en modelos &lt;48K ctx.
            <div style="margin-top:5px">
                <button class="ibtn xl" data-action="setToolsCompact" title="Cambiar a compact">&#x26A1;&ensp;Cambiar a compact</button>
            </div>
        </div>
    </div>` : ''}

    <!-- Especialista -->
    <div class="card">
        <div class="card-hdr">
            <span class="card-ico">&#x1F916;</span>
            <span class="card-ttl">Especialista Activo</span>
        </div>
        <select class="spec-sel" id="cfg-specialist" data-config="activeSpecialist">
            ${specialistOptionsHtml}
        </select>
        <p class="hint">"Auto" detecta por contexto. Fija uno para todas las conversaciones.</p>
    </div>

    <!-- SDD Workflow -->
    <div class="card">
        <div class="card-hdr">
            <span class="card-ico">&#x1F4CB;</span>
            <span class="card-ttl">SDD Workflow</span>
        </div>
        ${sddBody}
    </div>

    <!-- Agent Files -->
    <div class="card">
        <div class="card-hdr">
            <span class="card-ico">&#x1F4C4;</span>
            <span class="card-ttl">Agent.md (custom)</span>
            <div class="ibar" style="margin:0 0 0 auto">
                <button class="ibtn primary" data-action="browseAgent" title="Agregar archivo Agent.md">&#43;</button>
                ${agentPaths.length > 0 ? '<button class="ibtn danger" data-action="clearAgent" title="Limpiar todos">&#x1F5D1;</button>' : ''}
            </div>
        </div>
        ${agentChips}
    </div>

    <!-- Skills -->
    <div class="card">
        <div class="card-hdr">
            <span class="card-ico">&#x26A1;</span>
            <span class="card-ttl">Skills.md</span>
            <div class="ibar" style="margin:0 0 0 auto">
                <button class="ibtn primary" data-action="browseSkills" title="Seleccionar SKILLS.md">&#128194;</button>
                ${skillsPath ? '<button class="ibtn danger" data-action="clearSkills" title="Limpiar skills">&#x1F5D1;</button>' : ''}
            </div>
        </div>
        <div class="empty-hint" title="${escapeHtml(skillsPath)}">${escapeHtml(skillsFileName)}</div>
    </div>

    <!-- Configuración -->
    <div class="card">
        <div class="card-hdr">
            <span class="card-ico">&#x2699;</span>
            <span class="card-ttl">Configuraci&oacute;n</span>
        </div>
        <div class="cfg-grid">
            <div class="cfg-tile">
                <span class="cfg-tile-lbl">Temperatura</span>
                <input type="number" min="0" max="2" step="0.05" value="${temperature}" data-config="temperature">
            </div>
            <div class="cfg-tile">
                <span class="cfg-tile-lbl">Max Tokens</span>
                <input type="number" min="256" max="131072" step="256" value="${maxTokens}" data-config="maxTokens">
            </div>
            <div class="cfg-tile">
                <span class="cfg-tile-lbl">Max Iteraciones</span>
                <input type="number" min="1" max="50" step="1" value="${maxIterations}" data-config="maxIteraciones">
            </div>
            <div class="cfg-tile">
                <span class="cfg-tile-lbl">Tools Mode</span>
                <select data-config="toolsMode">
                    <option value="compact" ${toolsMode === 'compact' ? 'selected' : ''}>compact</option>
                    <option value="full"    ${toolsMode === 'full'    ? 'selected' : ''}>full</option>
                    <option value="off"     ${toolsMode === 'off'     ? 'selected' : ''}>off</option>
                </select>
            </div>
            <div class="cfg-tile cfg-span2">
                <span class="cfg-tile-lbl">Log Level</span>
                <select style="width:100%" data-config="logLevel">
                    <option value="DEBUG" ${logLevel === 'DEBUG' ? 'selected' : ''}>DEBUG</option>
                    <option value="INFO"  ${logLevel === 'INFO'  ? 'selected' : ''}>INFO</option>
                    <option value="WARN"  ${logLevel === 'WARN'  ? 'selected' : ''}>WARN</option>
                    <option value="ERROR" ${logLevel === 'ERROR' ? 'selected' : ''}>ERROR</option>
                </select>
            </div>
        </div>
    </div>

    <!-- Estadísticas -->
    <div class="card">
        <div class="card-hdr">
            <span class="card-ico">&#x1F4CA;</span>
            <span class="card-ttl">Estad&iacute;sticas</span>
            <button class="ibtn" style="margin-left:auto" data-action="resetStats" title="Resetear estad&iacute;sticas">&#x21BA;</button>
        </div>
        <div class="stats-grid">
            <div class="stat-tile"><span class="stat-val">${stats.totalRequests}</span><span class="stat-lbl">Requests</span></div>
            <div class="stat-tile"><span class="stat-val">${tokIn}</span><span class="stat-lbl">Tokens &#x2192;</span></div>
            <div class="stat-tile"><span class="stat-val">${tokOut}</span><span class="stat-lbl">Tokens &#x2190;</span></div>
            <div class="stat-tile"><span class="stat-val${stats.totalErrors > 0 ? ' er' : ''}">${stats.totalErrors}</span><span class="stat-lbl">Errores</span></div>
            <div class="stat-tile"><span class="stat-val">${avgDur}</span><span class="stat-lbl">Avg dur</span></div>
            <div class="stat-tile"><span class="stat-val">${successRate}%</span><span class="stat-lbl">&#x00C9;xito</span></div>
        </div>
        ${stats.lastModel ? `<div class="stats-meta">&#x1F916; ${escapeHtml(stats.lastModel)} &middot; ${relTime}</div>` : ''}
    </div>

    <!-- Herramientas -->
    <div class="card">
        <div class="card-hdr">
            <span class="card-ico">&#x1F527;</span>
            <span class="card-ttl">Herramientas</span>
        </div>
        <div class="ibar stretch">
            <button class="ibtn" data-action="openMcpConfig" title="Abrir .mcp.json — configura ia-orquestador e ia-recuerdo" style="width:auto;padding:0 10px">&#9881; .mcp.json</button>
            <button class="ibtn" data-action="openLog"       title="Abrir log — diagn&oacute;stico de tokens y errores"         style="width:auto;padding:0 10px">&#128196; Log</button>
        </div>
    </div>

    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        document.addEventListener('click', function(e) {
            const btn = e.target.closest('[data-action]');
            if (!btn) { return; }
            const action = btn.getAttribute('data-action');
            if      (action === 'browseAgent')    { vscode.postMessage({ command: 'browseAgent' }); }
            else if (action === 'clearAgent')     { vscode.postMessage({ command: 'clearAgent' }); }
            else if (action === 'browseSkills')   { vscode.postMessage({ command: 'browseSkills' }); }
            else if (action === 'clearSkills')    { vscode.postMessage({ command: 'clearSkills' }); }
            else if (action === 'openMcpConfig')  { vscode.postMessage({ command: 'openMcpConfig' }); }
            else if (action === 'openLog')        { vscode.postMessage({ command: 'openLog' }); }
            else if (action === 'setToolsCompact'){ vscode.postMessage({ command: 'setToolsCompact' }); }
            else if (action === 'removeAgent') {
                vscode.postMessage({ command: 'removeAgent', index: parseInt(btn.getAttribute('data-index'), 10) });
            }
            else if (action === 'startSdd')   { vscode.postMessage({ command: 'startSdd' }); }
            else if (action === 'cancelSdd')  { vscode.postMessage({ command: 'cancelSdd' }); }
            else if (action === 'resetStats') { vscode.postMessage({ command: 'resetStats' }); }
        });
        document.querySelectorAll('[data-config]').forEach(function(el) {
            el.addEventListener('change', function() {
                const key = el.getAttribute('data-config');
                const val = el.tagName === 'SELECT' ? el.value : parseFloat(el.value);
                vscode.postMessage({ command: 'setConfig', key: key, value: val });
            });
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
