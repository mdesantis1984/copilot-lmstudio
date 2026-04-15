/**
 * extension.ts — Punto de entrada principal del plugin VSIX
 * "Copilot + LM Studio — Local AI"
 *
 * Registra:
 *  1. LanguageModelChatProvider para LM Studio → modelos en el selector de Copilot
 *  2. Chat Participant @localai → interfaz dedicada en Copilot Chat
 *  3. Comandos de gestión de modelos
 *  4. Status bar de estado
 */

import * as vscode from 'vscode';
import { ModelManager } from './modelManager';
import { LocalModelProvider } from './localModelProvider';
import { registerChatParticipant } from './chatParticipant';
import { StatusBarManager } from './statusBar';
import { AgentPanelProvider } from './agentPanel';
import { ALL_SPECIALIST_IDS } from './agentRouter';
import { openMcpConfig, getMcpStatus } from './mcpDetector';
import { Logger } from './logger';
import { StatsTracker } from './statsTracker';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    // === 0. Inicializar Logger y StatsTracker (deben ser lo primero) ===
    const log = Logger.instance;
    await log.init(context);
    StatsTracker.init(context);
    log.info('Extension', 'Activating Copilot + LM Studio...');

    const manager = new ModelManager();
    const statusBar = new StatusBarManager(manager);

    // === 1. Registrar proveedor de modelos LLM de LM Studio ===
    if (typeof vscode.lm?.registerLanguageModelChatProvider === 'function') {
        context.subscriptions.push(
            vscode.lm.registerLanguageModelChatProvider(
                'lmstudio-local',
                new LocalModelProvider(manager)
            )
        );
    }

    // === 2. Registrar participante @localai en Copilot Chat ===
    registerChatParticipant(context, manager);

    // === 3. Registrar comandos ===
    context.subscriptions.push(
        vscode.commands.registerCommand('copilotLocal.listModels', async () => {
            const models = await manager.getAllModels(true);
            if (models.length === 0) {
                vscode.window.showInformationMessage(
                    'LM Studio no tiene modelos cargados. Abre LM Studio, carga un modelo y arranca el servidor local.',
                    'Abrir configuración'
                ).then(sel => {
                    if (sel) {
                        vscode.commands.executeCommand('workbench.action.openSettings', 'copilotLocal');
                    }
                });
                return;
            }

            const items = models.map(m => ({
                label: m.name,
                description: 'LM Studio (local)',
            }));

            await vscode.window.showQuickPick(items, {
                title: `Modelos en LM Studio (${models.length})`,
                placeHolder: 'Modelos cargados actualmente',
                canPickMany: false,
            });
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('copilotLocal.switchModel', async () => {
            const models = await manager.getAllModels();
            if (models.length === 0) {
                vscode.window.showWarningMessage('No hay modelos disponibles en LM Studio.');
                return;
            }

            const items = models.map(m => ({
                label: m.name,
                description: 'LM Studio (local)',
                modelId: m.id,
            }));

            const selected = await vscode.window.showQuickPick(items, {
                title: 'Seleccionar Modelo de LM Studio',
                placeHolder: 'Elige el modelo a usar por defecto',
            });

            if (selected) {
                await vscode.workspace.getConfiguration('copilotLocal').update(
                    'defaultModel',
                    selected.modelId,
                    vscode.ConfigurationTarget.Global
                );
                vscode.window.showInformationMessage(`✅ Modelo activo: ${selected.label}`);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('copilotLocal.checkStatus', async () => {
            const status = await manager.getBackendStatus();

            const buttons: string[] = [];
            if (status.available) { buttons.push('Ver modelos'); }
            buttons.push('Abrir configuración');

            const sel = await vscode.window.showInformationMessage(
                status.available
                    ? `LM Studio activo · ${status.modelCount} modelo${status.modelCount !== 1 ? 's' : ''} cargados`
                    : 'LM Studio no disponible — arranca el servidor local',
                ...buttons
            );

            if (sel === 'Ver modelos') {
                vscode.commands.executeCommand('copilotLocal.listModels');
            } else if (sel === 'Abrir configuración') {
                vscode.commands.executeCommand('workbench.action.openSettings', 'copilotLocal');
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('copilotLocal.openModelManager', () => {
            vscode.commands.executeCommand('workbench.action.openSettings', 'copilotLocal');
        })
    );

    // === 4. Registrar panel de agentes (Webview Sidebar) ===
    const agentProvider = new AgentPanelProvider(context.extensionUri, context, manager);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(AgentPanelProvider.viewType, agentProvider)
    );

    // === 5. Registrar panel SDD (eliminado — integrado en Agente & Skills) ===

    // === 6. Comando para abrir .mcp.json ===
    context.subscriptions.push(
        vscode.commands.registerCommand('copilotLocal.openMcpConfig', async () => {
            const status = await getMcpStatus();
            await openMcpConfig(status.mcpFilePath);
        })
    );

    // === 7. Comando para verificar estado MCP ===
    context.subscriptions.push(
        vscode.commands.registerCommand('copilotLocal.checkMcpStatus', async () => {
            const status = await getMcpStatus();
            const orchStatus = status.orchestrator ? '✅ configurado' : '❌ no configurado';
            const memStatus = status.memory ? '✅ configurado' : '❌ no configurado';
            const sel = await vscode.window.showInformationMessage(
                `MCP — ia-orquestador: ${orchStatus} · ia-recuerdo: ${memStatus}`,
                'Abrir .mcp.json'
            );
            if (sel) {
                await openMcpConfig(status.mcpFilePath);
            }
        })
    );

    // === 8. Escuchar cambios de configuración ===
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('copilotLocal')) {
                manager.onConfigurationChanged();
                statusBar.refresh();
            }
        })
    );

    // === 9. Comando para resetear estadísticas ===
    context.subscriptions.push(
        vscode.commands.registerCommand('copilotLocal.resetStats', () => {
            StatsTracker.instance.reset();
            vscode.window.showInformationMessage('✅ Estadísticas de Local AI reseteadas.');
        })
    );

    // === 10. Registrar LM Tools para GitHub Copilot Agent Mode ===
    // Permite que GitHub Copilot nativo invoque SDD, cambio de especialista y status.
    if (typeof (vscode.lm as Record<string, unknown>).registerTool === 'function') {
        const registerTool = (vscode.lm as unknown as {
            registerTool(name: string, tool: {
                invoke(opts: { input: Record<string, unknown> }, token: vscode.CancellationToken): Thenable<vscode.LanguageModelToolResult>;
            }): vscode.Disposable;
        }).registerTool;

        context.subscriptions.push(
            registerTool('localai_startSdd', {
                invoke: async (opts, _token) => {
                    const goal = String((opts.input as Record<string, unknown>).goal ?? '').trim();
                    await vscode.commands.executeCommand('workbench.action.chat.open', {
                        query: `@localai /sdd ${goal}`,
                    });
                    return new vscode.LanguageModelToolResult([
                        new vscode.LanguageModelTextPart(
                            `SDD Workflow iniciado${goal ? ` con el objetivo: "${goal}"` : ''}. ` +
                            `Copilot ha abierto el chat @localai. Sigue los 9 pasos: Explore → Design → Spec → Propose → Tasks → Apply → Verify → Archive.`
                        ),
                    ]);
                },
            }),
            registerTool('localai_setSpecialist', {
                invoke: async (opts, _token) => {
                    const specialist = String((opts.input as Record<string, unknown>).specialist ?? 'orchestrator');
                    const valid = ['orchestrator', ...ALL_SPECIALIST_IDS];
                    const id = valid.includes(specialist) ? specialist : 'orchestrator';
                    await vscode.workspace.getConfiguration('copilotLocal').update(
                        'activeSpecialist', id, vscode.ConfigurationTarget.Global
                    );
                    return new vscode.LanguageModelToolResult([
                        new vscode.LanguageModelTextPart(
                            `Especialista activo cambiado a "${id}". Las próximas consultas a @localai usarán este especialista.`
                        ),
                    ]);
                },
            }),
            registerTool('localai_getStatus', {
                invoke: async (_opts, _token) => {
                    const status = await manager.getBackendStatus();
                    const stats = StatsTracker.instance.get();
                    const successRate = stats.totalRequests > 0
                        ? Math.round(((stats.totalRequests - stats.totalErrors) / stats.totalRequests) * 100)
                        : 100;
                    const lines = status.available
                        ? [
                            `✅ LM Studio activo en ${status.url}`,
                            `Modelos cargados: ${status.modelCount}`,
                            `Último modelo: ${stats.lastModel || 'N/A'}`,
                            `Requests totales: ${stats.totalRequests}`,
                            `Tokens enviados: ${StatsTracker.formatTokens(stats.totalTokensIn)} | recibidos: ${StatsTracker.formatTokens(stats.totalTokensOut)}`,
                            `Tasa de éxito: ${successRate}% | Errores: ${stats.totalErrors}`,
                        ]
                        : [`❌ LM Studio no disponible en ${status.url}`];
                    return new vscode.LanguageModelToolResult([
                        new vscode.LanguageModelTextPart(lines.join('\n')),
                    ]);
                },
            })
        );
        log.info('Extension', 'LM Tools registrados: localai_startSdd, localai_setSpecialist, localai_getStatus');
    }

    // === 5. Iniciar status bar ===
    statusBar.start(context);
    context.subscriptions.push(new vscode.Disposable(() => statusBar.dispose()));

    const lmUrl = vscode.workspace.getConfiguration('copilotLocal').get<string>('lmStudioUrl') ?? 'http://localhost:1234';
    log.info('Extension', `Copilot + LM Studio activado. LM Studio URL: ${lmUrl}`);
    if (log.logFilePath) {
        log.info('Extension', `Log file: ${log.logFilePath}`);
    }
}

export function deactivate(): void {
    // Limpieza gestionada por Disposables en context.subscriptions
}

