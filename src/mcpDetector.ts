/**
 * mcpDetector.ts — Detecta si los servidores MCP requeridos están configurados
 * y expone helpers para interactuar con ia-recuerdo via JSON-RPC HTTP.
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

// ─── MCP HTTP helpers ─────────────────────────────────────────────────────────

/** Resultado de una llamada MCP tool. */
export interface McpToolResult {
    success: boolean;
    data?: unknown;
    error?: string;
}

/**
 * Llama a una herramienta MCP via JSON-RPC 2.0 HTTP (POST).
 * Timeout de 5 s. No lanza: devuelve { success: false, error } si falla.
 */
export async function callMcpTool(
    url: string,
    toolName: string,
    args: Record<string, unknown>
): Promise<McpToolResult> {
    const body = {
        jsonrpc: '2.0',
        id: Date.now(),
        method: 'tools/call',
        params: { name: toolName, arguments: args },
    };

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(5_000),
        });

        if (!response.ok) {
            return { success: false, error: `HTTP ${response.status}` };
        }

        const json = await response.json() as {
            result?: { content?: Array<{ type: string; text?: string }> };
            error?: { message?: string };
        };

        if (json.error) {
            return { success: false, error: json.error.message ?? 'MCP error' };
        }

        // Decodificar contenido text del resultado
        const textContent = json.result?.content
            ?.filter(c => c.type === 'text')
            .map(c => c.text ?? '')
            .join('') ?? '';

        let data: unknown = textContent;
        try { data = JSON.parse(textContent); } catch { /* mantener como string */ }

        return { success: true, data };
    } catch (e) {
        return { success: false, error: String(e) };
    }
}

// ─── ia-recuerdo helpers ───────────────────────────────────────────────────────

/**
 * Inicia una sesión de memoria en ia-recuerdo.
 * Devuelve el session_id o undefined si falla.
 */
export async function startMemorySession(
    memoryUrl: string,
    project: string,
    goal: string
): Promise<string | undefined> {
    const result = await callMcpTool(memoryUrl, 'mem_session_start', {
        agent: 'copilot-lmstudio',
        project,
        goal,
    });

    if (!result.success) {
        console.warn(`[copilot-lmstudio] startMemorySession failed: ${result.error}`);
        return undefined;
    }

    const data = result.data as { session_id?: string } | undefined;
    return data?.session_id;
}

/**
 * Busca contexto relevante en ia-recuerdo para el prompt actual.
 * Devuelve un bloque Markdown con los snippets encontrados, o '' si no hay nada.
 */
export async function getMemorySearchContext(
    memoryUrl: string,
    query: string,
    project?: string
): Promise<string> {
    const args: Record<string, unknown> = { query, limit: 5 };
    if (project) { args['project'] = project; }

    const result = await callMcpTool(memoryUrl, 'mem_search', args);

    if (!result.success || !result.data) { return ''; }

    type MemObs = { title: string; snippet: string; type?: string };
    const observations = (result.data as { observations?: MemObs[] })?.observations ?? [];
    if (observations.length === 0) { return ''; }

    const lines = observations.map(o =>
        `- **${o.title}** *(${o.type ?? 'context'})*: ${o.snippet?.slice(0, 200) ?? ''}`
    );
    return `## Contexto de sesiones anteriores\n\n${lines.join('\n')}\n`;
}

/**
 * Guarda el resumen de sesión en ia-recuerdo.
 * No lanza excepciones.
 */
export async function summarizeMemorySession(
    memoryUrl: string,
    sessionId: string,
    goal: string,
    accomplished: string,
    project: string
): Promise<void> {
    // Guardar resumen como observación
    await callMcpTool(memoryUrl, 'mem_session_summary', {
        session_id: sessionId,
        goal,
        accomplished,
        project,
    });
}

// ─── Historial ────────────────────────────────────────────────────────────────

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

    const result = await callMcpTool(memoryUrl, 'mem_save', {
        title: `Historial recortado — ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
        content,
        type: 'context',
        project: 'copilot-lmstudio',
    });

    if (!result.success) {
        console.warn(`[copilot-lmstudio] ia-recuerdo save failed: ${result.error}`);
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
