/**
 * LocalModelProvider — Implementa vscode.LanguageModelChatProvider
 * Registra los modelos de LM Studio como proveedores LLM nativos de VS Code,
 * visibles en el selector de modelos de Copilot Chat.
 *
 * API: vscode.lm.registerLanguageModelChatProvider (VS Code 1.95+)
 */

import * as vscode from 'vscode';
import { ModelManager } from './modelManager';
import { LmStudioChatMessage } from './lmStudioClient';

function extractText(message: vscode.LanguageModelChatMessage): string {
    const content = message.content as unknown;
    if (typeof content === 'string') { return content; }
    if (Array.isArray(content)) {
        return content
            .filter((p): p is vscode.LanguageModelTextPart => p instanceof vscode.LanguageModelTextPart)
            .map(p => p.value)
            .join('');
    }
    return '';
}

function mapRole(role: vscode.LanguageModelChatMessageRole): 'user' | 'assistant' | 'system' {
    if (role === vscode.LanguageModelChatMessageRole.User) { return 'user'; }
    if (role === vscode.LanguageModelChatMessageRole.Assistant) { return 'assistant'; }
    return 'system';
}

export class LocalModelProvider implements vscode.LanguageModelChatProvider {
    constructor(private readonly manager: ModelManager) {}

    async provideLanguageModelChatInformation(
        _options: { silent: boolean },
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelChatInformation[]> {
        try {
            const models = await this.manager.getAllModels();
            return models.map(m => ({
                id: m.id,
                name: `${m.displayName} [LM Studio]`,
                family: 'local',
                version: '1.0.0',
                maxInputTokens: 128_000,
                maxOutputTokens: 8_192,
                tooltip: [
                    'Modelo local via LM Studio',
                    '⚡ Coste cero · Sin Internet · Privado',
                ].join('\n'),
                capabilities: {
                    toolCalling: false,
                    imageInput: false,
                },
            }));
        } catch {
            return [];
        }
    }

    async provideLanguageModelChatResponse(
        model: vscode.LanguageModelChatInformation,
        messages: readonly vscode.LanguageModelChatMessage[],
        _options: vscode.ProvideLanguageModelChatResponseOptions,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        token: vscode.CancellationToken
    ): Promise<void> {
        const config = vscode.workspace.getConfiguration('copilotLocal');
        const systemPrompt = config.get<string>('systemPrompt') ?? '';
        const temperature = config.get<number>('temperature') ?? 0.7;
        const maxTokens = config.get<number>('maxTokens') ?? 4096;

        const abortController = new AbortController();
        token.onCancellationRequested(() => abortController.abort());

        const lmMessages: LmStudioChatMessage[] = [];
        if (systemPrompt) {
            lmMessages.push({ role: 'system', content: systemPrompt });
        }
        for (const msg of messages) {
            lmMessages.push({ role: mapRole(msg.role), content: extractText(msg) });
        }

        try {
            for await (const chunk of this.manager.lmStudio.chatStream(
                model.id, lmMessages, { temperature, maxTokens }, abortController.signal
            )) {
                progress.report(new vscode.LanguageModelTextPart(chunk));
            }
        } catch (err) {
            if (!token.isCancellationRequested) {
                const msg = err instanceof Error ? err.message : String(err);
                progress.report(new vscode.LanguageModelTextPart(
                    `\n\n❌ Error de LM Studio: ${msg}\n\n` +
                    `Verifica que LM Studio esté corriendo en http://localhost:1234 ` +
                    `con el servidor local activo.`
                ));
            }
        }
    }

    async provideTokenCount(
        _model: vscode.LanguageModelChatInformation,
        text: string | vscode.LanguageModelChatMessage,
        _token: vscode.CancellationToken
    ): Promise<number> {
        const content = typeof text === 'string' ? text : extractText(text);
        return Math.max(1, Math.ceil(content.length / 4));
    }
}

