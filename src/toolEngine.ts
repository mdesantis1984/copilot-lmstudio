/**
 * ToolEngine — Motor agéntico para @localai
 *
 * Permite que modelos de LM Studio usen TODAS las herramientas disponibles
 * en VS Code: MCP tools, file system, extensiones, etc.
 *
 * Flujo:
 *  1. Obtiene las herramientas registradas en vscode.lm.tools (incluye MCP)
 *  2. Inyecta su descripción en el system prompt con un formato XML
 *  3. Ejecuta un loop agéntico:
 *       a. Envía mensajes al modelo
 *       b. Parsea <tool_use> del output
 *       c. Ejecuta herramientas via vscode.lm.invokeTool
 *       d. Añade resultados al historial y vuelve a llamar al modelo
 *  4. Para cuando no hay más tool calls o se alcanza MAX_ITERATIONS
 */

import * as vscode from 'vscode';
import { LmStudioClient, LmStudioChatMessage, CHARS_PER_TOKEN } from './lmStudioClient';
import { Logger } from './logger';

const MAX_ITERATIONS = 20; // fallback si la config no está disponible
const DEFAULT_MAX_INJECTED_TOOLS = 60; // hard cap por defecto para evitar inyección masiva
const TOOL_TAG_OPEN  = '<tool_use>';
const TOOL_TAG_CLOSE = '</tool_use>';

// ─────────────────────────────────────────────────────────────────────────────
// Tipos internos
// ─────────────────────────────────────────────────────────────────────────────

interface ToolCall {
    name: string;
    parameters: Record<string, unknown>;
}

interface ParsedResponse {
    textParts: string[];
    toolCalls: ToolCall[];
    warnings: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// API de herramientas (VS Code 1.99+)
// ─────────────────────────────────────────────────────────────────────────────

/** Devuelve todas las herramientas registradas en VS Code, incluyendo MCP. */
export function getAvailableTools(): vscode.LanguageModelToolInformation[] {
    try {
        if (!vscode.lm || !Array.isArray((vscode.lm as { tools?: unknown }).tools)) {
            return [];
        }
        return [...(vscode.lm as unknown as { tools: readonly vscode.LanguageModelToolInformation[] }).tools];
    } catch {
        return [];
    }
}

/** ¿Está disponible la API de invocación de herramientas? */
function canInvokeTools(): boolean {
    return typeof (vscode.lm as Record<string, unknown>)?.invokeTool === 'function';
}

async function invokeTool(
    name: string,
    input: Record<string, unknown>,
    toolInvocationToken: vscode.ChatParticipantToolToken | undefined,
    token: vscode.CancellationToken
): Promise<string> {
    const invokeFn = (vscode.lm as Record<string, unknown>).invokeTool as (
        name: string,
        options: { input: Record<string, unknown>; toolInvocationToken: vscode.ChatParticipantToolToken | undefined },
        token: vscode.CancellationToken
    ) => Thenable<{ content: unknown[] }>;

    const log = Logger.instance;

    // --- Sanitización / validación / fallback basada en esquema (mejorada) ---
    const sanitizeToolInput = (toolName: string, raw: Record<string, unknown>) => {
        const s: Record<string, unknown> = { ...(raw ?? {}) };

        try {
            // Fallback para copilot_findFiles: si no se provee path, usar workspace root
            if (toolName === 'copilot_findFiles') {
                if (typeof s.path === 'undefined' || s.path === null) {
                    const folders = vscode.workspace.workspaceFolders;
                    const defaultPath = folders?.[0]?.uri.fsPath ?? '.';
                    s.path = defaultPath;
                    log.debug('ToolEngine', 'copilot_findFiles: se aplicó path por defecto', { defaultPath });
                }
                if (typeof s.path !== 'string') { s.path = String(s.path); }
            }

            if (toolName === 'copilot_readFile' || toolName === 'copilot_listDirectory' || toolName === 'copilot_readProjectStructure') {
                if (typeof s.path !== 'undefined' && s.path !== null && typeof s.path !== 'string') { s.path = String(s.path); }
            }

            if (toolName === 'run_in_terminal') {
                const cmd = typeof s.command === 'string' ? s.command : String(s.command ?? '');
                if (!cmd.trim()) {
                    return { ok: false, error: "Falta o está vacío el parámetro 'command'" };
                }
                s.command = cmd;

                if (process.platform === 'win32') {
                    if (/^\s*ls(\s|$)/.test(cmd)) {
                        const rest = cmd.replace(/^\s*ls\s*/, '');
                        s.command = `powershell -Command "Get-ChildItem ${rest.replace(/"/g, '\\"')}"`;
                    }
                }

                // Normalizar la forma de indicar modo síncrono
                const mode = s.mode ?? (s.isBackground === false ? 'sync' : undefined);
                if (mode === 'sync' && typeof s.timeout === 'undefined') {
                    s.timeout = 5000;
                }
            }

            // Reemplazar `undefined` por null para evitar errores en consumidores que no toleran undefined
            for (const k of Object.keys(s)) {
                if (typeof s[k] === 'undefined') { s[k] = null; }
            }

            // Validación ligera contra schema si existe en la lista de tools registrada
            const toolInfo = getAvailableTools().find(t => t.name === toolName);
            if (toolInfo?.inputSchema && typeof toolInfo.inputSchema === 'object') {
                const schema: any = toolInfo.inputSchema as any;
                // Validar campos `required` simples
                if (Array.isArray(schema.required)) {
                    for (const req of schema.required) {
                        if (!(req in s) || s[req] === null) {
                            return { ok: false, error: `Falta el campo requerido '${req}' según inputSchema` };
                        }
                    }
                }
                // Validar tipos básicos si están descritos en properties
                if (schema.properties && typeof schema.properties === 'object') {
                    for (const [prop, propSchema] of Object.entries(schema.properties)) {
                        if (s[prop] == null) { continue; }
                        const expected = (propSchema as any).type;
                        if (expected && typeof expected === 'string') {
                            const val = s[prop];
                            if (expected === 'string' && typeof val !== 'string') { s[prop] = String(val); }
                            if (expected === 'number' && typeof val !== 'number') {
                                const n = Number(val);
                                if (!Number.isNaN(n)) { s[prop] = n; } else {
                                    return { ok: false, error: `Tipo inválido para '${prop}': se esperaba number` };
                                }
                            }
                            if (expected === 'boolean' && typeof val !== 'boolean') {
                                s[prop] = val === 'true' || val === true;
                            }
                        }
                    }
                }
            }

            return { ok: true, value: s };
        } catch (e) {
            return { ok: false, error: String(e) };
        }
    };

    const validation = sanitizeToolInput(name, input);
    if (!validation.ok) {
        const errMsg = validation.error ?? 'Parámetros inválidos';
        log.debug('ToolEngine', 'Tool call validation failed', { tool: name, error: errMsg, input });
        return `[Tool ${name}: parámetros inválidos — ${errMsg}]`;
    }

    const sanitizedInput = validation.value as Record<string, unknown>;

    // Manejar operaciones de archivos comunes LOCALMENTE usando las APIs de VS Code
    // Esto evita depender de invocaciones a la shell (ls/Get-ChildItem) y hace el
    // comportamiento consistente en Windows/Linux.
    const localFileTools = new Set([
        'copilot_findFiles', 'copilot_readFile', 'copilot_listDirectory', 'copilot_readProjectStructure'
    ]);

    if (localFileTools.has(name)) {
        try {
            if (name === 'copilot_findFiles') {
                const basePath = String(sanitizedInput.path ?? '.');
                const query = typeof sanitizedInput.query === 'string'
                    ? sanitizedInput.query
                    : (typeof sanitizedInput.pattern === 'string' ? sanitizedInput.pattern : undefined);
                const glob = typeof sanitizedInput.glob === 'string' ? sanitizedInput.glob : undefined;
                const maxResults = Number(sanitizedInput.maxResults ?? 200);

                let uris: vscode.Uri[] = [];
                // Si el usuario pasa un glob relativo al path, usar RelativePattern
                if (glob) {
                    try {
                        const rp = new vscode.RelativePattern(vscode.Uri.file(basePath), glob);
                        uris = await vscode.workspace.findFiles(rp, undefined, maxResults);
                    } catch (e) {
                        uris = await vscode.workspace.findFiles(glob, undefined, maxResults);
                    }
                } else if (query) {
                    // Buscar archivos que contengan el query en su nombre
                    const sanitizedBase = basePath.replace(/\\\\/g, '/').replace(/\/$/, '');
                    const pattern = `${sanitizedBase}/**/*${query}*`;
                    try {
                        uris = await vscode.workspace.findFiles(pattern, '**/node_modules/**', maxResults);
                    } catch (e) {
                        uris = await vscode.workspace.findFiles(`**/*${query}*`, '**/node_modules/**', maxResults);
                    }
                } else {
                    // Listar archivos bajo basePath recursivamente (limitado)
                    const sanitizedBase = basePath.replace(/\\\\/g, '/').replace(/\/$/, '');
                    const pattern = `${sanitizedBase}/**/*`;
                    try {
                        uris = await vscode.workspace.findFiles(pattern, '**/node_modules/**', maxResults);
                    } catch (e) {
                        uris = await vscode.workspace.findFiles('**/*', '**/node_modules/**', maxResults);
                    }
                }

                if (!uris || uris.length === 0) { return `[copilot_findFiles: sin resultados en ${basePath}]`; }
                return uris.map(u => u.fsPath).join('\n');
            }

            if (name === 'copilot_readFile') {
                const p = String(sanitizedInput.path ?? '');
                if (!p) { return '[copilot_readFile: path vacío]'; }
                const uri = vscode.Uri.file(p);
                const bytes = await vscode.workspace.fs.readFile(uri);
                return new TextDecoder().decode(bytes);
            }

            if (name === 'copilot_listDirectory') {
                const p = String(sanitizedInput.path ?? '.');
                const uri = vscode.Uri.file(p);
                const entries = await vscode.workspace.fs.readDirectory(uri);
                const lines = entries.map(([name, type]) => `${type === vscode.FileType.Directory ? 'DIR' : 'FILE'} ${name}`);
                return lines.join('\n');
            }

            if (name === 'copilot_readProjectStructure') {
                const folders = vscode.workspace.workspaceFolders ?? [];
                const lines: string[] = [];
                for (const f of folders) {
                    lines.push(`Workspace: ${f.name} -> ${f.uri.fsPath}`);
                    const files = await vscode.workspace.findFiles(new vscode.RelativePattern(f, '**/*.{cs,ts,js,md,json,csproj,fsproj}'), '**/node_modules/**', 200);
                    for (const u of files.slice(0, 100)) { lines.push(` - ${u.fsPath}`); }
                }
                return lines.join('\n');
            }
        } catch (e) {
            log.error('ToolEngine', 'Local file-op handler error', { tool: name, error: String(e) });
            return `[Tool ${name}: error interno al manejar operaciones de archivos — ${String(e)}]`;
        }
    }

    // Llamada real a la API del host
    const result = await invokeFn(name, { input: sanitizedInput, toolInvocationToken }, token);

    if (!result?.content || !Array.isArray(result.content)) {
        return `[Tool ${name}: sin contenido en la respuesta]`;
    }

    const decodePart = (part: unknown): string => {
        try {
            if (typeof part === 'string') { return part; }
            if (!part || typeof part !== 'object') { return ''; }
            const p: any = part;
            if ('value' in p && typeof p.value === 'string') { return p.value; }
            if ('text' in p && typeof p.text === 'string') { return p.text; }
            if ('data' in p) {
                const data = p.data;
                // Node Buffer
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const anyBuf: any = (globalThis as any).Buffer;
                if (anyBuf && anyBuf.isBuffer && anyBuf.isBuffer(data)) {
                    return anyBuf.from(data).toString('utf8');
                }
                if (data instanceof Uint8Array) { return new TextDecoder().decode(data); }
                if (Array.isArray(data)) { return new TextDecoder().decode(Uint8Array.from(data)); }
            }
            // Fallback: stringify para evitar pérdida total de información
            return JSON.stringify(p);
        } catch {
            return '';
        }
    };

    return result.content.map(decodePart).filter(Boolean).join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Construcción del system prompt con catálogo de herramientas
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Construye el bloque de instrucciones de herramientas para el system prompt.
 *
 * @param tools        Lista de herramientas disponibles.
 * @param maxChars     Presupuesto máximo en chars para el bloque completo.
 *                     Por defecto 8 000 chars (~2 000 tokens) — seguro para modelos 7B.
 * @param detailLevel  'compact' (solo nombre+descripción) o 'full' (con JSON schema).
 *                     Por defecto 'compact' para no superar el contexto.
 */
export function buildToolsSystemPrompt(
    tools: vscode.LanguageModelToolInformation[],
    maxChars = 8_000,
    detailLevel: 'compact' | 'full' = 'compact'
): string {
    if (tools.length === 0) { return ''; }
    // Aplicar tope configurable al número de herramientas que inyectamos
    const cfgMax = vscode.workspace.getConfiguration('copilotLocal').get<number>('maxInjectedTools');
    const maxInjected = (typeof cfgMax === 'number' && isFinite(cfgMax) && cfgMax > 0)
        ? Math.max(1, Math.floor(cfgMax))
        : DEFAULT_MAX_INJECTED_TOOLS;
    const toolsToUse = tools.slice(0, maxInjected);
    const skippedByCap = tools.length - toolsToUse.length;

    const HEADER = `\n## Herramientas disponibles\n\nPuedes usar herramientas para acceder al workspace, sistema de archivos, terminal y más.\nCuando necesites una herramienta, emite EXACTAMENTE este formato:\n\n${TOOL_TAG_OPEN}\n<tool_name>nombre_de_la_herramienta</tool_name>\n<parameters>{"parametro1": "valor1", "parametro2": "valor2"}</parameters>\n${TOOL_TAG_CLOSE}\n\nReglas importantes:\n- Usa herramientas ANTES de responder si necesitas info del workspace o archivos\n- Espera el resultado de cada herramienta antes de invocar otra\n- NO inventes resultados; usa siempre la herramienta para obtenerlos\n- Si tienes toda la información necesaria, responde directamente sin usar tools\n\n`;

    const budgetForCatalog = maxChars - HEADER.length - 100; // 100 chars de margen

    if (detailLevel === 'full') {
        // Formato completo: nombre + descripción + JSON schema.
        // Añadir herramientas hasta agotar el presupuesto.
        const entries: string[] = [];
        let used = 0;
        for (const t of toolsToUse) {
            let entry = `### ${t.name}\n${t.description}`;
            if (t.inputSchema) {
                entry += `\nEsquema:\n\`\`\`json\n${JSON.stringify(t.inputSchema, null, 2)}\n\`\`\``;
            }
            if (used + entry.length + 2 > budgetForCatalog) { break; }
            entries.push(entry);
            used += entry.length + 2;
        }
        const skipped = tools.length - entries.length;
        const catalog = entries.join('\n\n') +
            (skipped > 0 ? `\n\n*... y ${skipped} herramientas más disponibles (presupuesto de contexto agotado)*` : '');
        const shown = toolsToUse.length;
        const headerLine = `## Catálogo (${shown} de ${tools.length} herramientas):\n\n` + (skippedByCap > 0 ? `*Se han omitido ${skippedByCap} herramientas por tope configurado.*\n\n` : '');
        return HEADER + headerLine + `${catalog}\n`;
    }

    // Formato compacto (por defecto): tabla Markdown de 2 columnas.
    // ~15-25 chars por fila → 170 tools ≈ 3 000–4 000 chars (~1 000 tokens).
    const rows: string[] = [];
    let used = 0;
    const tableHeader = `## Catálogo de herramientas disponibles (${toolsToUse.length} de ${tools.length}):\n\n| Herramienta | Descripción |\n|-------------|-------------|\n`;
    used = tableHeader.length;

    for (const t of toolsToUse) {
        // Truncar descripción a 120 chars para mantener la tabla compacta
        const desc = (t.description ?? '').replace(/\n/g, ' ').slice(0, 120);
        const row = `| \`${t.name}\` | ${desc} |\n`;
        if (used + row.length > budgetForCatalog) { break; }
        rows.push(row);
        used += row.length;
    }

    const skipped = tools.length - rows.length;
    let footer = '';
    if (skipped > 0) {
        footer = `\n*... y ${skipped} herramientas más (usa \`/status\` para ver la lista completa)*\n`;
    }
    if (skippedByCap > 0) {
        footer = `\n*Se han omitido ${skippedByCap} herramientas por el tope de inyección (${maxInjected}).*\n` + footer;
    }

    return HEADER + tableHeader + rows.join('') + footer;
}

// ─────────────────────────────────────────────────────────────────────────────
// Parser de respuestas del modelo
// ─────────────────────────────────────────────────────────────────────────────

function parseResponse(text: string): ParsedResponse {
    const toolCalls: ToolCall[] = [];
    const textParts: string[] = [];
    const warnings: string[] = [];

    // Protección contra XML injection: enmascarar regiones de code-fence (```...```)
    // para que un modelo que explique el formato <tool_use> en texto no lo ejecute.
    // El enmascarado preserva exactamente la longitud del texto para que los índices
    // coincidan entre el original (usado en textParts) y el enmascarado (usado en indexOf).
    const masked = text.replace(/```[\s\S]*?```/g, m => ' '.repeat(m.length));

    let remaining = text;
    let maskedRemaining = masked;

    while (remaining.length > 0) {
        const startIdx = maskedRemaining.indexOf(TOOL_TAG_OPEN);
        if (startIdx === -1) {
            const trimmed = remaining.trim();
            if (trimmed) { textParts.push(trimmed); }
            break;
        }

        // Texto antes del tool call
        const textBefore = remaining.slice(0, startIdx).trim();
        if (textBefore) { textParts.push(textBefore); }

        const endIdx = maskedRemaining.indexOf(TOOL_TAG_CLOSE, startIdx);
        if (endIdx === -1) {
            // Tag incompleto, tratar el resto como texto
            textParts.push(remaining.slice(startIdx).trim());
            break;
        }

        const block = remaining.slice(startIdx + TOOL_TAG_OPEN.length, endIdx);
        const nameMatch   = block.match(/<tool_name>([\w_:\-/.]+)<\/tool_name>/);
        const paramsMatch = block.match(/<parameters>([\s\S]*?)<\/parameters>/);

        if (nameMatch) {
            const toolName = nameMatch[1].trim();
            let params: Record<string, unknown> = {};
            if (paramsMatch) {
                try {
                    params = JSON.parse(paramsMatch[1].trim());
                } catch {
                    // JSON mal formado → parámetros vacíos; notificar al usuario
                    warnings.push(`Parámetros malformados para '${toolName}' — la herramienta se invocará sin parámetros`);
                }
            }
            toolCalls.push({ name: toolName, parameters: params });
        }

        const consumed = endIdx + TOOL_TAG_CLOSE.length;
        remaining = remaining.slice(consumed);
        maskedRemaining = maskedRemaining.slice(consumed);
    }

    return { textParts, toolCalls, warnings };
}

// ─────────────────────────────────────────────────────────────────────────────
// Validación final de mensajes contra ventana de contexto
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Trim holístico: asegura que la suma de TODOS los mensajes cabe en la ventana.
 * 1. Cuenta chars totales de todos los mensajes
 * 2. Si excede el budget, recorta history primero, luego system prompt
 * 3. Nunca permite que el total supere (contextLength - maxTokens) en tokens estimados
 */
function validateAndTrimMessages(
    messages: LmStudioChatMessage[],
    contextLength: number,
    maxTokens: number
): LmStudioChatMessage[] {
    const log = Logger.instance;
    const availableTokens = contextLength - maxTokens - 200; // 200 tokens margen plantilla chat
    const maxTotalChars = Math.floor(availableTokens * CHARS_PER_TOKEN);

    // IMPORTANTE: siempre trabajar sobre una COPIA para no mutar el array original.
    // Retornar `messages` directamente causaba un bug de referencia compartida
    // cuando el caller hacía `workingMessages.length = 0; workingMessages.push(...validated)`.
    const result = [...messages];

    const calcTotalChars = () => result.reduce((sum, m) => sum + (m.content?.length ?? 0), 0);
    let total = calcTotalChars();

    log.debug('ToolEngine', 'validateAndTrimMessages', {
        contextLength, maxTokens, availableTokens, maxTotalChars,
        currentTotalChars: total,
        estimatedTokens: Math.ceil(total / CHARS_PER_TOKEN),
        messageCount: result.length,
    });

    if (total <= maxTotalChars) { return result; }

    // Guardar copia del último mensaje del usuario (si existe) para garantizar su preservación
    let lastUserIdx = -1;
    for (let i = result.length - 1; i >= 0; i--) {
        if (result[i].role === 'user') { lastUserIdx = i; break; }
    }
    const lastUserCopy = lastUserIdx >= 0 ? { ...result[lastUserIdx] } : null;
    const lastUserOriginalLength = lastUserCopy ? (lastUserCopy.content?.length ?? 0) : 0;

    // Fase 1: Recortar mensajes de historial (de más antiguo a más reciente),
    // pero NUNCA reemplazar/eliminar la entrada identificada como el último user message.
    const historyStart = 1;
    const historyEnd = result.length - 1;
    for (let i = historyStart; i < historyEnd && calcTotalChars() > maxTotalChars; i++) {
        if (i === lastUserIdx) { continue; }
        const removed = result[i];
        result[i] = { role: removed.role, content: '[recortado por límite de contexto]' };
        log.warn('ToolEngine', `Historial[${i}] truncado (${(removed.content?.length ?? 0)} chars)`);
    }

    total = calcTotalChars();

    // Fase 2: Recortar system prompt si aún excede. Calcular espacio real para system
    if (total > maxTotalChars && result.length > 0 && result[0].role === 'system') {
        const sysLen = result[0].content?.length ?? 0;
        const otherLen = total - sysLen;
        // Espacio permitido para system prompt después de mantener el resto (puede ser 0)
        let allowedSys = Math.max(Math.floor(maxTotalChars - otherLen), 0);
        if (sysLen > allowedSys) {
            log.warn('ToolEngine', `System prompt truncado: ${sysLen} → ${allowedSys} chars`);
            result[0] = {
                role: 'system',
                content: (result[0].content ?? '').slice(0, allowedSys) +
                    '\n\n*[System prompt recortado — ventana de contexto insuficiente]*',
            };
        }
    }

    // A estas alturas, asegurarnos de que el último mensaje del usuario está presente
    // y es el último elemento del array. Si fue eliminado o reemplazado, reinsertarlo
    // (posiblemente truncado) como última entrada.
    total = calcTotalChars();
    if (lastUserCopy) {
        // Buscar una entrada igual a la copia original
        let foundIdx = -1;
        for (let i = 0; i < result.length; i++) {
            if (result[i].role === 'user' && result[i].content === lastUserCopy.content) { foundIdx = i; break; }
        }

        if (foundIdx >= 0) {
            // mover a la última posición si no lo es
            if (foundIdx !== result.length - 1) {
                const [m] = result.splice(foundIdx, 1);
                result.push(m);
            }
        } else {
            // No existe: insertarla truncada si hace falta para caber
            const totalNow = calcTotalChars();
            // Espacio disponible si añadimos la entrada completa
            let availableForLast = maxTotalChars - totalNow;
            // Si no hay espacio, permitir truncado: intentar liberar espacio adicional
            if (availableForLast < lastUserOriginalLength) {
                // Propuesta: permitir al menos 30 chars del último mensaje
                let allowed = Math.max(Math.min(lastUserOriginalLength, Math.floor(maxTotalChars - (totalNow - lastUserOriginalLength))), 30);
                if (allowed < 0) { allowed = Math.min(30, lastUserOriginalLength); }
                let contentToInsert = lastUserCopy.content ?? '';
                if (contentToInsert.length > allowed) { contentToInsert = contentToInsert.slice(0, allowed) + '...[recortado]'; }
                result.push({ role: 'user', content: contentToInsert });
                log.warn('ToolEngine', 'Se ha preservado (posiblemente truncado) el último mensaje del usuario para evitar pérdida de contexto.');
            } else {
                // Hay espacio suficiente para insertar completo
                result.push({ role: 'user', content: lastUserCopy.content });
            }
        }
    }

    log.info('ToolEngine', 'Post-trim', {
        finalChars: calcTotalChars(),
        estimatedTokens: Math.ceil(calcTotalChars() / CHARS_PER_TOKEN),
        contextLength,
    });

    return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Loop agéntico principal
// ─────────────────────────────────────────────────────────────────────────────

export async function runAgentLoop(
    client: LmStudioClient,
    modelId: string,
    messages: LmStudioChatMessage[],
    onText: (text: string) => void,
    onProgress: (msg: string) => void,
    toolInvocationToken: vscode.ChatParticipantToolToken | undefined,
    cancellationToken: vscode.CancellationToken,
    options: { temperature: number; maxTokens: number; contextLength?: number; toolsMaxChars?: number; toolsDetail?: 'compact' | 'full' }
): Promise<void> {
    const tools = getAvailableTools();
    const toolsEnabled = tools.length > 0 && canInvokeTools();
    const log = Logger.instance;
    const maxIterations = vscode.workspace.getConfiguration('copilotLocal').get<number>('maxIterations') ?? MAX_ITERATIONS;

    // Modo sin herramientas: streaming directo con validación de contexto.
    if (!toolsEnabled) {
        const abort = new AbortController();
        cancellationToken.onCancellationRequested(() => abort.abort());

        const ctxTokens = options.contextLength ?? 16_384;
        const validated = validateAndTrimMessages(messages, ctxTokens, options.maxTokens);

        // Debug: registrar snapshot de mensajes que se envían al modelo (no tools)
        try {
            const snap = validated.map(m => ({ role: m.role, preview: (m.content ?? '').replace(/\n/g, ' ').slice(0, 800) }));
            log.debug('ToolEngine', 'Outgoing messages (no-tools)', { messageCount: snap.length, messages: snap });
        } catch (e) {
            log.debug('ToolEngine', 'Outgoing messages (no-tools) failed to stringify', { error: String(e) });
        }

        for await (const chunk of client.chatStream(modelId, validated, options, abort.signal)) {
            onText(chunk);
        }
        return;
    }

    // Inyectar catálogo de herramientas en el system prompt, respetando el presupuesto de chars.
    const workingMessages = [...messages];
    if (workingMessages.length > 0 && workingMessages[0].role === 'system') {
        const toolsBlock = buildToolsSystemPrompt(
            tools,
            options.toolsMaxChars ?? 8_000,
            options.toolsDetail ?? 'compact'
        );
        workingMessages[0] = {
            role: 'system',
            content: workingMessages[0].content + '\n' + toolsBlock,
        };

        // === Validación holística de contexto ===
        // En vez de un hard cap por separado al system prompt, validamos TODOS
        // los mensajes como un todo contra la ventana de contexto.
        const ctxTokens = options.contextLength ?? 16_384;
        const validated = validateAndTrimMessages(workingMessages, ctxTokens, options.maxTokens);
        workingMessages.length = 0;
        workingMessages.push(...validated);

        const sysContent = workingMessages[0]?.content ?? '';
        log.info('ToolEngine', 'System prompt + tools inyectados', {
            systemChars: sysContent.length,
            systemEstimatedTokens: Math.ceil(sysContent.length / CHARS_PER_TOKEN),
            toolCount: tools.length,
            contextLength: ctxTokens,
            messageCount: workingMessages.length,
        });
    }

    // Loop agéntico
    for (let iter = 0; iter < maxIterations; iter++) {
        if (cancellationToken.isCancellationRequested) { break; }

        // Recopilar respuesta completa del modelo
        const abort = new AbortController();
        cancellationToken.onCancellationRequested(() => abort.abort());

        // Debug: antes de llamar al modelo, registrar snapshot de workingMessages
        try {
            const snap = workingMessages.map(m => ({ role: m.role, preview: (m.content ?? '').replace(/\n/g, ' ').slice(0, 800) }));
            log.debug('ToolEngine', 'Outgoing messages (tools-enabled)', { iteration: iter, messageCount: snap.length, messages: snap });
        } catch (e) {
            log.debug('ToolEngine', 'Outgoing messages (tools-enabled) failed to stringify', { error: String(e) });
        }

        let fullResponse = '';
        onProgress(iter === 0 ? `Pensando con ${modelId}...` : 'Procesando resultados...');

        try {
            for await (const chunk of client.chatStream(modelId, workingMessages, options, abort.signal)) {
                fullResponse += chunk;
            }
        } catch (err) {
            if (!cancellationToken.isCancellationRequested) {
                throw err;
            }
            break;
        }

        if (!fullResponse.trim()) { break; }

        // Parsear respuesta
        const parsed = parseResponse(fullResponse);

        // Mostrar partes de texto al usuario
        for (const textPart of parsed.textParts) {
            if (textPart.trim()) { onText(textPart + '\n\n'); }
        }

        // Advertencias de parsing (ej. JSON malformado en parámetros)
        for (const warning of parsed.warnings) {
            onText(`> ⚠️ *${warning}*\n\n`);
        }

        // Sin tool calls → terminado
        if (parsed.toolCalls.length === 0) { break; }

        // Añadir mensaje del asistente al historial
        workingMessages.push({ role: 'assistant', content: fullResponse });

        // Ejecutar tool calls
        const toolResults: string[] = [];

        for (const toolCall of parsed.toolCalls) {
            if (cancellationToken.isCancellationRequested) { break; }

            onProgress(`🔧 Ejecutando: ${toolCall.name}...`);
            log.debug('ToolEngine', 'Tool call input', {
                tool: toolCall.name,
                parameters: toolCall.parameters,
            });

            try {
                const resultText = await invokeTool(
                    toolCall.name,
                    toolCall.parameters,
                    toolInvocationToken,
                    cancellationToken
                );

                // Recortar resultado largo para no saturar el log
                const resultPreview = resultText.length > 500
                    ? resultText.slice(0, 500) + `...[+${resultText.length - 500} chars]`
                    : resultText;
                log.debug('ToolEngine', 'Tool call result', {
                    tool: toolCall.name,
                    resultChars: resultText.length,
                    preview: resultPreview,
                });

                toolResults.push(
                    `<tool_result>\n` +
                    `<tool_name>${toolCall.name}</tool_name>\n` +
                    `<result>${resultText}</result>\n` +
                    `</tool_result>`
                );
                onText(`> ✅ **\`${toolCall.name}\`** ejecutado\n\n`);
            } catch (err) {
                const errMsg = err instanceof Error ? err.message : String(err);
                log.debug('ToolEngine', 'Tool call error', {
                    tool: toolCall.name,
                    error: errMsg,
                });
                toolResults.push(
                    `<tool_result>\n` +
                    `<tool_name>${toolCall.name}</tool_name>\n` +
                    `<error>${errMsg}</error>\n` +
                    `</tool_result>`
                );
                onText(`> ❌ **\`${toolCall.name}\`** error: ${errMsg}\n\n`);
            }
        }

        // Añadir resultados al historial para la siguiente iteración
        workingMessages.push({
            role: 'user',
            content: toolResults.join('\n\n') +
                '\n\nContinúa con tu respuesta final basándote en los resultados obtenidos.',
        });

        // Notificar si se alcanzó el límite de iteraciones con tool calls pendientes
        if (iter === maxIterations - 1) {
            onText(`\n\n⚠️ *Límite de iteraciones alcanzado (${maxIterations}). El agente puede no haber completado todas las acciones.*\n\n`);
        }
    }
}
