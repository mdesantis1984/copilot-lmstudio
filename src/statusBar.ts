/**
 * StatusBar — Indicador de estado de LM Studio en la barra inferior de VS Code.
 * Click abre el menú de estado rápido.
 */

import * as vscode from 'vscode';
import { ModelManager } from './modelManager';

export class StatusBarManager {
    private readonly item: vscode.StatusBarItem;
    private refreshTimer?: NodeJS.Timeout;

    constructor(private readonly manager: ModelManager) {
        this.item = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Right,
            100
        );
        this.item.command = 'copilotLocal.checkStatus';
        this.item.tooltip = 'Copilot + LM Studio — Click para ver estado';
    }

    start(context: vscode.ExtensionContext): void {
        const config = vscode.workspace.getConfiguration('copilotLocal');
        if (!config.get<boolean>('showStatusBar', true)) { return; }

        context.subscriptions.push(this.item);
        this.refresh();

        this.refreshTimer = setInterval(() => this.refresh(), 30_000);
        context.subscriptions.push(
            new vscode.Disposable(() => {
                if (this.refreshTimer) { clearInterval(this.refreshTimer); }
            })
        );
    }

    async refresh(): Promise<void> {
        this.item.text = '$(loading~spin) LM Studio';
        this.item.show();

        try {
            const status = await this.manager.getBackendStatus();

            if (!status.available) {
                this.item.text = '$(circle-slash) LM Studio';
                this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
                this.item.tooltip = 'LM Studio — Servidor local no disponible\nClick para verificar';
            } else {
                const n = status.modelCount;
                this.item.text = `$(sparkle) LM Studio · ${n} modelo${n !== 1 ? 's' : ''}`;
                this.item.backgroundColor = undefined;
                this.item.tooltip = [
                    'Copilot + LM Studio',
                    `✅ Activo en ${status.url}`,
                    `${n} modelo${n !== 1 ? 's' : ''} cargados`,
                    'Click para ver detalles',
                ].join('\n');
            }
        } catch {
            this.item.text = '$(warning) LM Studio';
            this.item.backgroundColor = undefined;
        }
    }

    dispose(): void {
        if (this.refreshTimer) { clearInterval(this.refreshTimer); }
        this.item.dispose();
    }
}

