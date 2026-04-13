/**
 * mcpDetector.ts — Detecta si los servidores MCP requeridos están configurados.
 *
 * Verifica el archivo %USERPROFILE%\.mcp.json buscando las entradas:
 *   - ia-orquestador (habilita habilidades .NET y SDD)
 *   - ia-recuerdo    (habilita persistencia de memoria)
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface McpStatus {
    orchestrator: boolean;
    memory: boolean;
    memoryUrl?: string;
    mcpFilePath: string;
}

/**
 * Lee %USERPROFILE%\.mcp.json y verifica si los servidores están registrados.
 */
export async function getMcpStatus(): Promise<McpStatus> {
    const mcpFilePath = path.join(os.homedir(), '.mcp.json');
    const result: McpStatus = {
        orchestrator: false,
        memory: false,
        mcpFilePath,
    };

    try {
        if (!fs.existsSync(mcpFilePath)) {
            return result;
        }

        const raw = fs.readFileSync(mcpFilePath, 'utf8');
        // Validar que sea JSON válido antes de parsear
        const config = JSON.parse(raw) as Record<string, unknown>;

        const servers = (config['servers'] ?? config['mcpServers'] ?? {}) as Record<string, unknown>;

        result.orchestrator = 'ia-orquestador' in servers || 'ia-orquestado' in servers;

        const memKey = 'ia-recuerdo' in servers ? 'ia-recuerdo'
            : 'ia-memoria' in servers ? 'ia-memoria'
            : null;
        if (memKey) {
            result.memory = true;
            const memServer = servers[memKey] as { url?: string };
            result.memoryUrl = memServer.url;
        }
    } catch {
        // Archivo no existe o JSON inválido → reportar como no configurado
    }

    return result;
}

/**
 * Guarda mensajes de historial descartados en ia-recuerdo via MCP over HTTP.
 * No lanza excepciones: si el servidor no responde, registra en consola y continúa.
 */
export async function saveDroppedHistoryToMemory(
    messages: { role: string; content: string }[],
    memoryUrl: string
): Promise<void> {
    const content = messages
        .map(m => `**[${m.role === 'user' ? 'Usuario' : 'Asistente'}]**: ${m.content}`)
        .join('\n\n---\n\n');

    const body = {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
            name: 'mem_save',
            arguments: {
                title: `Historial recortado — ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
                content,
                type: 'context',
                project: 'copilot-lmstudio',
            },
        },
    };

    try {
        const response = await fetch(memoryUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(5_000),
        });
        if (!response.ok) {
            console.warn(`[copilot-lmstudio] ia-recuerdo save failed: HTTP ${response.status}`);
        }
    } catch (e) {
        console.warn(`[copilot-lmstudio] ia-recuerdo unreachable: ${e}`);
    }
}

/**
 * Muestra un banner con instrucciones de instalación cuando falta algún servidor MCP.
 */
export function showMcpInstallBanner(
    stream: vscode.ChatResponseStream,
    status: McpStatus
): void {
    const missing: string[] = [];
    if (!status.orchestrator) { missing.push('ia-orquestador'); }
    if (!status.memory) { missing.push('ia-recuerdo'); }

    if (missing.length === 0) { return; }

    stream.markdown(
        '\n---\n' +
        '> ⚡ **Amplía las capacidades con servidores MCP**\n>\n' +
        `> Los siguientes servidores no están configurados: **${missing.join(', ')}**\n>\n` +
        '> Agregarlos desbloquea:\n' +
        (status.orchestrator ? '' : '> - **ia-orquestador**: 18 habilidades .NET + flujo SDD guiado\n') +
        (status.memory ? '' : '> - **ia-recuerdo**: Memoria persistente entre sesiones\n') +
        '>\n' +
        `> Abre \`${status.mcpFilePath}\` y agrega:\n` +
        '> ```json\n' +
        '> {\n' +
        '>   "servers": {\n' +
        (status.orchestrator ? '' :
            '>     "ia-orquestador": {\n' +
            '>       "url": "http://localhost:7437/mcp",\n' +
            '>       "type": "http"\n' +
            '>     }') +
        ((!status.orchestrator && !status.memory) ? ',\n' : '\n') +
        (status.memory ? '' :
            '>     "ia-recuerdo": {\n' +
            '>       "url": "http://localhost:7438/mcp",\n' +
            '>       "type": "http"\n' +
            '>     }\n') +
        '>   }\n' +
        '> }\n' +
        '> ```\n' +
        '---\n\n'
    );
}

/**
 * Abre el archivo .mcp.json en el editor. Lo crea si no existe.
 */
export async function openMcpConfig(mcpFilePath: string): Promise<void> {
    if (!fs.existsSync(mcpFilePath)) {
        const template = JSON.stringify({
            servers: {
                'ia-orquestador': {
                    url: 'http://localhost:7437/mcp',
                    type: 'http',
                },
                'ia-recuerdo': {
                    url: 'http://localhost:7438/mcp',
                    type: 'http',
                },
            },
        }, null, 2);
        fs.writeFileSync(mcpFilePath, template, 'utf8');
    }

    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(mcpFilePath));
    await vscode.window.showTextDocument(doc);
}
