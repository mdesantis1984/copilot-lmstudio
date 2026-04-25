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

interface JsonRpcToolPart {
    value?: string;
    text?: string;
    data?: unknown;
}

function decodeToolContent(content: unknown): string {
    if (typeof content === 'string') { return content; }
    if (Array.isArray(content)) {
        return content.map(part => decodeToolContent(part)).filter(Boolean).join('\n');
    }
    if (!content || typeof content !== 'object') { return ''; }

    const part = content as JsonRpcToolPart & Record<string, unknown>;
    if (typeof part.value === 'string') { return part.value; }
    if (typeof part.text === 'string') { return part.text; }

    if ('data' in part) {
        const data = part.data;
        const anyBuf: any = (globalThis as any).Buffer;
        if (anyBuf && anyBuf.isBuffer && anyBuf.isBuffer(data)) {
            return anyBuf.from(data).toString('utf8');
        }
        if (data instanceof Uint8Array) { return new TextDecoder().decode(data); }
        if (Array.isArray(data)) { return new TextDecoder().decode(Uint8Array.from(data)); }
    }

    return JSON.stringify(content);
}

async function callMcpTool(
    mcpUrl: string,
    name: string,
    args: Record<string, unknown> = {},
    timeoutMs = 5_000
): Promise<string | null> {
    try {
        const response = await fetch(mcpUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'tools/call',
                params: { name, arguments: args },
            }),
            signal: AbortSignal.timeout(timeoutMs),
        });

        if (!response.ok) {
            return null;
        }

        const raw = await response.text();
        try {
            const parsed = JSON.parse(raw) as { result?: unknown; error?: { message?: string } };
            if (parsed.error) { return null; }
            return decodeToolContent((parsed.result ?? parsed) as unknown);
        } catch {
            return raw.trim();
        }
    } catch {
        return null;
    }
}

function buildMemoryQuery(prompt: string): string {
    return prompt
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 180);
}

const startedMemorySessions = new Set<string>();

function memorySessionKey(memoryUrl: string, project: string, agent: string): string {
    return `${memoryUrl}::${project}::${agent}`;
}

export async function getMemorySearchContext(memoryUrl: string, prompt: string, project: string): Promise<string> {
    const query = buildMemoryQuery(prompt);
    const [context, search] = await Promise.all([
        callMcpTool(memoryUrl, 'mem_context', { project, agent: 'orchestrator', goal: query }),
        callMcpTool(memoryUrl, 'mem_search', { project, query, topic_key: query, agent: 'orchestrator' }),
    ]);

    const blocks: string[] = [];
    if (context) { blocks.push(`### mem_context\n${context}`); }
    if (search) {
        blocks.push(`### mem_search\n${search}`);

        const ids = [...new Set((search.match(/(?:observation_id|id)\s*[:=]?\s*(\d+)/gi) ?? [])
            .map(match => Number((match.match(/(\d+)/)?.[1] ?? '0')))
            .filter(n => Number.isFinite(n) && n > 0))].slice(0, 3);

        for (const id of ids) {
            const timeline = await callMcpTool(memoryUrl, 'mem_timeline', { observation_id: id, project, agent: 'orchestrator' });
            const observation = await callMcpTool(memoryUrl, 'mem_get_observation', { id, project, agent: 'orchestrator' });
            if (timeline) { blocks.push(`### mem_timeline #${id}\n${timeline}`); }
            if (observation) { blocks.push(`### mem_get_observation #${id}\n${observation}`); }
        }
    }

    return blocks.join('\n\n');
}

export async function startMemorySession(
    memoryUrl: string,
    project: string,
    goal: string,
    agent = 'orchestrator'
): Promise<void> {
    const key = memorySessionKey(memoryUrl, project, agent);
    if (startedMemorySessions.has(key)) { return; }
    startedMemorySessions.add(key);
    await callMcpTool(memoryUrl, 'mem_session_start', { project, agent, goal });
}

export async function summarizeMemorySession(
    memoryUrl: string,
    params: {
        project: string;
        goal: string;
        discoveries: string[];
        accomplished: string[];
        files_touched: string[];
        agent?: string;
    }
): Promise<void> {
    await callMcpTool(memoryUrl, 'mem_session_summary', {
        project: params.project,
        agent: params.agent ?? 'orchestrator',
        goal: params.goal,
        discoveries: params.discoveries,
        accomplished: params.accomplished,
        files_touched: params.files_touched,
    });
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
    const result = await callMcpTool(memoryUrl, 'mem_save', {
        title: `Historial recortado — ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
        content,
        type: 'context',
        project: 'copilot-lmstudio',
    });

    if (result === null) {
        console.warn('[copilot-lmstudio] ia-recuerdo save failed or unreachable');
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
