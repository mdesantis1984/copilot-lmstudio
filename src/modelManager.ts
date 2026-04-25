/**
 * ModelManager — Descubrimiento y gestión de modelos de LM Studio.
 * Refresca la lista de modelos bajo demanda y al cambiar la configuración.
 */

import * as vscode from 'vscode';
import { LmStudioClient, LmStudioModel } from './lmStudioClient';

export interface LocalModel {
    id: string;
    name: string;
    displayName: string;
    sizeBytes: number;
}

export interface BackendStatus {
    available: boolean;
    modelCount: number;
    url: string;
}

export class ModelManager {
    private lmStudioClient: LmStudioClient;
    private cachedModels: LocalModel[] = [];
    private lastRefresh = 0;
    private readonly CACHE_TTL_MS = 30_000;

    constructor() {
        const config = vscode.workspace.getConfiguration('copilotLocal');
        this.lmStudioClient = new LmStudioClient(
            config.get<string>('lmStudioUrl') ?? 'http://localhost:1234'
        );
    }

    onConfigurationChanged(): void {
        const config = vscode.workspace.getConfiguration('copilotLocal');
        try {
            this.lmStudioClient = new LmStudioClient(
                config.get<string>('lmStudioUrl') ?? 'http://localhost:1234'
            );
        } catch (err) {
            vscode.window.showWarningMessage(`URL de LM Studio inválida: ${err}`);
        }
        this.invalidateCache();
    }

    invalidateCache(): void {
        this.lastRefresh = 0;
        this.cachedModels = [];
    }

    get lmStudio(): LmStudioClient {
        return this.lmStudioClient;
    }

    async getAllModels(forceRefresh = false): Promise<LocalModel[]> {
        const now = Date.now();
        if (!forceRefresh && this.cachedModels.length > 0 && now - this.lastRefresh < this.CACHE_TTL_MS) {
            return this.cachedModels;
        }

        try {
            const lmModels = await this.lmStudioClient.listModels();
            this.cachedModels = lmModels.map(m => this.toLocalModel(m));
        } catch {
            this.cachedModels = [];
        }

        this.lastRefresh = Date.now();
        return this.cachedModels;
    }

    async getDefaultModel(): Promise<LocalModel | undefined> {
        const config = vscode.workspace.getConfiguration('copilotLocal');
        const defaultId = config.get<string>('defaultModel') ?? '';
        const models = await this.getAllModels();

        if (defaultId) {
            const found = models.find(m => m.id === defaultId || m.name === defaultId);
            if (found) { return found; }
        }
        return models[0];
    }

    async getBackendStatus(): Promise<BackendStatus> {
        const config = vscode.workspace.getConfiguration('copilotLocal');
        const url = config.get<string>('lmStudioUrl') ?? 'http://localhost:1234';
        const available = await this.lmStudioClient.isAvailable();
        let modelCount = 0;

        if (available) {
            try {
                // Timeout corto (4s) para el status check — evitar bloquear el panel
                const models = await this.lmStudioClient.listModels(AbortSignal.timeout(4000));
                modelCount = models.length;
            } catch {
                // Ignorar
            }
        }

        return { available, modelCount, url };
    }

    private toLocalModel(m: LmStudioModel): LocalModel {
        return {
            id: m.id,
            name: m.id,
            displayName: m.id,
            sizeBytes: 0,
        };
    }
}
