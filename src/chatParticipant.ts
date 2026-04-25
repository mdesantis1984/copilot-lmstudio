/**
 * ChatParticipant — Participante @localai para Copilot Chat
 *
 * Orquestra agentes especialistas, flujo SDD guiado y herramientas MCP.
 *
 * Comandos disponibles:
 *   /models    → lista los modelos disponibles en LM Studio
 *   /switch    → cambia el modelo activo
 *   /status    → muestra el estado del servidor LM Studio
 *   /sdd       → inicia el flujo Spec-Driven Development (9 pasos)
 *   /agent     → fuerza un especialista: /agent azure, /agent blazor-server, etc.
 *   /next      → avanza al siguiente paso del flujo SDD activo
 *   /reset     → cancela el flujo SDD activo
 */

import * as vscode from 'vscode';
import { ModelManager, LocalModel } from './modelManager';
import { LmStudioChatMessage, CHARS_PER_TOKEN, ModelInfo } from './lmStudioClient';
import { runAgentLoop, getAvailableTools } from './toolEngine';
import { Logger } from './logger';
import {
    detectSpecialist,
    loadSpecialistPrompt,
    loadAdditionalSkills,
    loadCustomAgents,
    getSpecialistDisplayName,
    SpecialistId,
    ALL_SPECIALIST_IDS,
} from './agentRouter';
import {
    startSdd,
    advanceSddStep,
    resetSdd,
    isSddActive,
    buildSddSystemPrompt,
    getSddState,
    STEP_NAMES,
} from './sddWorkflow';
import { getMcpStatus, showMcpInstallBanner, saveDroppedHistoryToMemory, startMemorySession, getMemorySearchContext, summarizeMemorySession } from './mcpDetector';

/** Versión visible en el header del chat — confirma qué código está activo. */
const EXTENSION_VERSION = '1.1.47';

interface LocalAiChatResult extends vscode.ChatResult {
    metadata: {
        command: string;
        modelUsed?: string;
        specialist?: SpecialistId;
    };
}

let activeModelId: string | undefined;

/** Estado de sesión ia-recuerdo activa. Se reutiliza durante toda la vida de la extensión. */
let memorySessionId: string | undefined;
let memorySessionGoal: string | undefined;

export function registerChatParticipant(
    context: vscode.ExtensionContext,
    manager: ModelManager
): void {
    const participant = vscode.chat.createChatParticipant(
        'copilot-local.localai',
        createHandler(manager, context)
    );

    participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'assets', 'icon.png');


    participant.followupProvider = {
        provideFollowups(
            result: LocalAiChatResult,
            _context: vscode.ChatContext,
            _token: vscode.CancellationToken
        ): vscode.ChatFollowup[] {
            if (result.metadata.command === 'models') {
                return [{ prompt: '/switch', label: 'Cambiar modelo activo', command: 'switch' }];
            }
            // Followups del flujo SDD
            if (result.metadata.command === 'sdd' || isSddActive()) {
                return [
                    { prompt: '/reset', label: 'Cancelar flujo SDD', command: 'reset' },
                ];
            }
            if (result.metadata.modelUsed) {
                const followups: vscode.ChatFollowup[] = [
                    { prompt: '¿Puedes refactorizar el código anterior?', label: 'Refactorizar' },
                    { prompt: '¿Puedes añadir tests unitarios?', label: 'Agregar tests' },
                    { prompt: '/models', label: 'Ver modelos disponibles', command: 'models' },
                ];
                if (result.metadata.specialist && result.metadata.specialist !== 'orchestrator') {
                    followups.unshift({
                        prompt: `Siguiendo con ${getSpecialistDisplayName(result.metadata.specialist)}, ¿podés profundizar más?`,
                        label: 'Profundizar',
                    });
                }
                return followups;
            }
            return [];
        },
    };

    context.subscriptions.push(participant);
}

function createHandler(manager: ModelManager, context: vscode.ExtensionContext): vscode.ChatRequestHandler {
    return async (
        request: vscode.ChatRequest,
        chatContext: vscode.ChatContext,
        stream: vscode.ChatResponseStream,
        token: vscode.CancellationToken
    ): Promise<LocalAiChatResult> => {
        if (request.command === 'status') { return handleStatus(manager, stream); }
        if (request.command === 'models') { return handleListModels(manager, stream); }
        if (request.command === 'switch') { return handleSwitchModel(manager, stream, request.prompt); }

        // Comandos SDD — deben ir ANTES del bloque ALL_SPECIALIST_IDS
        if (request.command === 'sdd') {
            // Inicializar el estado SDD (paso = init) con el objetivo del usuario
            const goal = request.prompt.trim() || undefined;
            startSdd(goal);

            // Pre-explorar el workspace en TypeScript (sin depender de que el LLM llame herramientas)
            // e inyectar los datos directamente en el prompt del LLM
            stream.progress('Explorando workspace...');
            const wsExploration = await exploreWorkspaceForSdd();

            // Crear un request "decorado" que incluye la exploración del workspace en el prompt
            const enrichedPrompt = wsExploration
                ? `${request.prompt.trim() || 'analiza el workspace'}

---
**Datos del workspace (exploración automática, no asumir ni inventar datos adicionales):**

${wsExploration}`
                : request.prompt;

            // Proxy del request con prompt enriquecido
            const enrichedRequest = Object.create(request) as vscode.ChatRequest;
            Object.defineProperty(enrichedRequest, 'prompt', { get: () => enrichedPrompt });

            return handleChat(manager, stream, token, enrichedRequest, chatContext, context, 'sdd');
        }
        if (request.command === 'next') {
            const nextPrompt = advanceSddStep(request.prompt.trim() || undefined);
            stream.markdown(nextPrompt);
            return { metadata: { command: 'sdd', specialist: 'sdd' } };
        }
        if (request.command === 'reset') {
            resetSdd();
            stream.markdown('🔄 Flujo SDD cancelado. Puedes empezar uno nuevo con `/sdd`.');
            return { metadata: { command: 'reset' } };
        }

        // Comando /agent: con argumento fuerza el especialista; sin argumento abre un Quick Pick
        if (request.command === 'agent') {
            const arg = request.prompt.trim();
            if (arg && ALL_SPECIALIST_IDS.includes(arg as SpecialistId)) {
                return handleChat(manager, stream, token, request, chatContext, context, arg as SpecialistId);
            }
            // Sin argumento válido → QuickPick con los 27 especialistas
            const picked = await vscode.window.showQuickPick(
                ALL_SPECIALIST_IDS.map(id => ({
                    label: getSpecialistDisplayName(id),
                    description: id,
                    id,
                })),
                { placeHolder: 'Selecciona un especialista', title: 'Copilot Local — Especialistas' }
            );
            if (!picked) {
                stream.markdown('_Operación cancelada._');
                return { metadata: { command: 'agent' } };
            }
            return handleChat(manager, stream, token, request, chatContext, context, picked.id as SpecialistId);
        }

        // Comando directo de especialista: /csharp, /go, /blazor-server, etc.
        if (request.command && ALL_SPECIALIST_IDS.includes(request.command as SpecialistId)) {
            return handleChat(manager, stream, token, request, chatContext, context, request.command as SpecialistId);
        }

        return handleChat(manager, stream, token, request, chatContext, context);
    };
}

async function handleStatus(
    manager: ModelManager,
    stream: vscode.ChatResponseStream
): Promise<LocalAiChatResult> {
    stream.progress('Verificando LM Studio...');
    const status = await manager.getBackendStatus();

    stream.markdown('## Estado de LM Studio\n\n');

    if (status.available) {
        stream.markdown(
            `✅ **LM Studio** — Activo en \`${status.url}\` · ` +
            `${status.modelCount} modelo${status.modelCount !== 1 ? 's' : ''} cargados\n\n`
        );
    } else {
        stream.markdown(
            `❌ **LM Studio** — No disponible en \`${status.url}\`\n\n` +
            `> **Para activarlo:**\n` +
            `> 1. Abre LM Studio\n` +
            `> 2. Carga un modelo en la sección *My Models*\n` +
            `> 3. Ve a la pestaña **Local Server** y haz clic en **Start Server**\n\n`
        );
    }

    if (activeModelId) {
        stream.markdown(`🤖 **Modelo activo:** \`${activeModelId}\`\n`);
    }

    return { metadata: { command: 'status' } };
}

async function handleListModels(
    manager: ModelManager,
    stream: vscode.ChatResponseStream
): Promise<LocalAiChatResult> {
    stream.progress('Obteniendo modelos de LM Studio...');

    let models: LocalModel[] = [];
    try {
        models = await manager.getAllModels(true);
    } catch (err) {
        stream.markdown(`❌ No se pudieron obtener los modelos: ${err}\n`);
        return { metadata: { command: 'models' } };
    }

    if (models.length === 0) {
        stream.markdown(
            '## Sin Modelos en LM Studio\n\n' +
            'LM Studio no tiene modelos cargados actualmente.\n\n' +
            '**Pasos para activar un modelo:**\n' +
            '1. Abre LM Studio\n' +
            '2. Descarga un modelo desde el catálogo de **Discover**\n' +
            '3. Cárgalo en la sección **My Models**\n' +
            '4. Ve a **Local Server** → **Start Server**\n'
        );
        return { metadata: { command: 'models' } };
    }

    stream.markdown(`## Modelos Disponibles en LM Studio (${models.length})\n\n`);

    for (const m of models) {
        const active = m.id === activeModelId ? ' ⭐ *(activo)*' : '';
        stream.markdown(`- \`${m.name}\`${active}\n`);
    }

    stream.markdown(
        '\n> Usa `/switch <nombre>` para cambiar el modelo activo.\n'
    );

    return { metadata: { command: 'models' } };
}

async function handleSwitchModel(
    manager: ModelManager,
    stream: vscode.ChatResponseStream,
    prompt: string
): Promise<LocalAiChatResult> {
    const modelName = prompt.trim();

    if (!modelName) {
        const models = await manager.getAllModels();
        if (models.length === 0) {
            stream.markdown('No hay modelos disponibles en LM Studio. Carga uno y arranca el servidor local.');
            return { metadata: { command: 'switch' } };
        }
        stream.markdown('## Modelos Disponibles\n\nEspecifica el nombre: `/switch <modelo>`\n\n');
        for (const m of models) {
            const active = m.id === activeModelId ? ' ← activo' : '';
            stream.markdown(`- \`${m.name}\`${active}\n`);
        }
        return { metadata: { command: 'switch' } };
    }

    const models = await manager.getAllModels();
    const found = models.find(m =>
        m.id === modelName || m.name === modelName || m.name.startsWith(modelName)
    );

    if (!found) {
        stream.markdown(
            `❌ Modelo \`${modelName}\` no encontrado en LM Studio.\n\n` +
            `Usa \`/models\` para ver los modelos disponibles.`
        );
        return { metadata: { command: 'switch' } };
    }

    activeModelId = found.id;

    await vscode.workspace.getConfiguration('copilotLocal').update(
        'defaultModel',
        found.id,
        vscode.ConfigurationTarget.Global
    );

    stream.markdown(`✅ Modelo cambiado a **\`${found.name}\`**\n`);
    return { metadata: { command: 'switch', modelUsed: found.id } };
}

/**
 * Resuelve las referencias adjuntas a la petición (#file, #selection, #codebase, etc.)
 * y devuelve un bloque de contexto para incluir en el prompt.
 */
async function resolveReferences(references: readonly vscode.ChatPromptReference[]): Promise<string> {
    if (references.length === 0) { return ''; }

    const parts: string[] = [];

    for (const ref of references) {
        try {
            // #selection o #editor — contenido del editor activo
            if (ref.value instanceof vscode.Location) {
                const doc = await vscode.workspace.openTextDocument(ref.value.uri);
                const text = doc.getText(ref.value.range);
                const relPath = vscode.workspace.asRelativePath(ref.value.uri);
                parts.push(`### Selección de \`${relPath}\`\n\`\`\`\n${text}\n\`\`\``);
            }
            // #file — URI de archivo
            else if (ref.value instanceof vscode.Uri) {
                const doc = await vscode.workspace.openTextDocument(ref.value);
                const relPath = vscode.workspace.asRelativePath(ref.value);
                const lang = doc.languageId;
                parts.push(`### Archivo \`${relPath}\`\n\`\`\`${lang}\n${doc.getText()}\n\`\`\``);
            }
            // String directo (puede ser contenido o ruta)
            else if (typeof ref.value === 'string' && ref.value.trim()) {
                parts.push(`### Contexto adjunto\n${ref.value}`);
            }
        } catch {
            // Referencia no accesible, ignorar
        }
    }

    if (parts.length === 0) { return ''; }
    return '\n\n---\n**Contexto del workspace adjunto:**\n\n' + parts.join('\n\n');
}

/**
 * Pre-explora el workspace leyendo package.json, tsconfig.json, *.csproj, *.sln
 * y listando los directorios de primer nivel. Retorna un bloque de texto Markdown
 * listo para inyectar en el mensaje del usuario, sin depender de que el LLM llame herramientas.
 */
async function exploreWorkspaceForSdd(): Promise<string> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) { return ''; }

    const log = Logger.instance;
    const lines: string[] = ['## Exploración automática del workspace\n'];

    for (const folder of folders) {
        const root = folder.uri;
        lines.push(`### ${folder.name} (\`${root.fsPath}\`)\n`);

        // 1. Listar entradas de primer nivel
        try {
            const entries = await vscode.workspace.fs.readDirectory(root);
            const items = entries.map(([name, type]) =>
                type === vscode.FileType.Directory ? `📁 ${name}/` : `📄 ${name}`
            );
            lines.push('**Estructura raíz:**\n```\n' + items.join('\n') + '\n```\n');
        } catch (e) {
            log.warn('ChatParticipant', `No se pudo listar ${root.fsPath}: ${e}`);
        }

        // 2. Leer archivos de stack
        const stackFiles = ['package.json', 'tsconfig.json', 'package-lock.json',
            'pyproject.toml', 'requirements.txt', 'Dockerfile',
            'Directory.Build.props', 'global.json'];
        for (const filename of stackFiles) {
            try {
                const uri = vscode.Uri.joinPath(root, filename);
                const bytes = await vscode.workspace.fs.readFile(uri);
                const content = Buffer.from(bytes).toString('utf-8').slice(0, 2000);
                lines.push(`**\`${filename}\`:**\n\`\`\`\n${content}\n\`\`\`\n`);
            } catch {
                // archivo no existe – ignorar
            }
        }

        // 3. Buscar *.csproj y *.sln (primer nivel y un nivel de profundidad)
        try {
            const csprojFiles = await vscode.workspace.findFiles(
                new vscode.RelativePattern(folder, '**/*.{csproj,sln}'),
                '**/node_modules/**', 5
            );
            if (csprojFiles.length > 0) {
                const names = csprojFiles.map(u => vscode.workspace.asRelativePath(u));
                lines.push(`**Proyectos .NET encontrados:** ${names.join(', ')}\n`);
                // Leer el primero para obtener más info
                try {
                    const bytes = await vscode.workspace.fs.readFile(csprojFiles[0]);
                    const content = Buffer.from(bytes).toString('utf-8').slice(0, 1000);
                    lines.push(`**\`${names[0]}\`:**\n\`\`\`xml\n${content}\n\`\`\`\n`);
                } catch { /* ignorar */ }
            }
        } catch { /* ignorar */ }
    }

    const result = lines.join('\n');
    log.info('ChatParticipant', 'Workspace pre-explorado', { chars: result.length });
    return result;
}

/**
 * Genera un resumen del workspace activo para orientar al modelo.
 */
function getWorkspaceSummary(): string {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) { return ''; }

    const workspacePaths = folders.map(f => `- ${f.name}: \`${f.uri.fsPath}\``).join('\n');
    const editor = vscode.window.activeTextEditor;
    const activeFile = editor
        ? `Archivo activo: \`${vscode.workspace.asRelativePath(editor.document.uri)}\` (${editor.document.languageId})`
        : '';

    return `## Workspace\n${workspacePaths}${activeFile ? '\n' + activeFile : ''}`;
}

async function handleChat(
    manager: ModelManager,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
    request: vscode.ChatRequest,
    chatContext: vscode.ChatContext,
    context: vscode.ExtensionContext,
    forcedSpecialist?: SpecialistId
): Promise<LocalAiChatResult> {
    let model: LocalModel | undefined;
    if (activeModelId) {
        const models = await manager.getAllModels();
        model = models.find(m => m.id === activeModelId);
    }
    if (!model) {
        model = await manager.getDefaultModel();
    }

    if (!model) {
        stream.markdown(
            '## Sin modelos disponibles\n\n' +
            '❌ LM Studio no tiene modelos cargados.\n\n' +
            '1. Abre LM Studio y carga un modelo\n' +
            '2. Ve a **Local Server** → **Start Server**\n' +
            '3. Usa `/models` para ver los modelos disponibles\n'
        );
        return { metadata: { command: '' } };
    }

    stream.progress(`Enviando a ${model.name}...`);

    // === ia-recuerdo: iniciar sesión y recuperar contexto ===
    const mcpStatusEarly = await getMcpStatus();
    let memoryContext = '';
    if (mcpStatusEarly.memory && mcpStatusEarly.memoryUrl) {
        const memUrl = mcpStatusEarly.memoryUrl;

        // Iniciar sesión si no hay una activa
        if (!memorySessionId) {
            const goal = request.prompt.slice(0, 120);
            memorySessionId = await startMemorySession(memUrl, 'copilot-lmstudio', goal);
            memorySessionGoal = goal;
        }

        // Buscar contexto relevante para el prompt actual
        memoryContext = await getMemorySearchContext(memUrl, request.prompt.slice(0, 200), 'copilot-lmstudio');
    }

    const config = vscode.workspace.getConfiguration('copilotLocal');
    const temperature = config.get<number>('temperature') ?? 0.7;
    const maxTokens = config.get<number>('maxTokens') ?? 4096;
    const showMcpBanner = config.get<boolean>('showMcpBanner') ?? true;
    const toolsMode = config.get<'compact' | 'full' | 'off'>('toolsMode') ?? 'compact';

    // === Consultar info completa del modelo activo en LM Studio ===
    const modelInfo: ModelInfo | null = await manager.lmStudio.getFullModelInfo(model.id);
    const contextLength = modelInfo?.contextLength ?? 16_384;
    const maxContextLength = modelInfo?.maxContextLength ?? contextLength;
    const log = Logger.instance;

    log.info('ChatParticipant', 'Model info', {
        modelId: model.id,
        contextLength,
        maxContextLength,
        flashAttention: modelInfo?.flashAttention,
        numExperts: modelInfo?.numExperts,
        trainedForToolUse: modelInfo?.trainedForToolUse,
        quantization: modelInfo?.quantization,
    });

    // Presupuesto de tokens reservados para system prompt (~60%), tools (~25%), historial (~15%).
    // Dejamos maxTokens + 800 tokens de margen para la respuesta + overhead de plantilla de chat.
    const reservedTokens = maxTokens + 800;
    const systemPromptBudgetTokens = Math.max(Math.floor((contextLength - reservedTokens) * 0.60), 1_500);
    const toolsBudgetTokens       = Math.max(Math.floor((contextLength - reservedTokens) * 0.25), 1_000);
    const historyBudgetTokens     = Math.max(Math.floor((contextLength - reservedTokens) * 0.15), 1_000);

    // Convertir presupuestos de tokens a chars usando CHARS_PER_TOKEN (2.0).
    // Este ratio es CONSERVADOR — sobreestima tokens, lo que significa que
    // recortamos más de lo necesario, pero NUNCA causamos n_keep >= n_ctx.
    const tokenToChars = (t: number) => Math.floor(t * CHARS_PER_TOKEN);
    const systemPromptBudgetChars = tokenToChars(systemPromptBudgetTokens);
    const toolsMaxChars           = tokenToChars(toolsBudgetTokens);
    const historyBudgetChars      = tokenToChars(historyBudgetTokens);

    log.info('ChatParticipant', 'Budget calculation', {
        reservedTokens,
        systemPromptBudgetTokens, systemPromptBudgetChars,
        toolsBudgetTokens, toolsMaxChars,
        historyBudgetTokens, historyBudgetChars,
        charsPerToken: CHARS_PER_TOKEN,
    });

    // === Detección de especialista ===
    const routing = detectSpecialist(request.prompt, context.extensionPath);
    // Si el usuario fijó un especialista en el sidebar (no 'orchestrator'), usarlo.
    // forcedSpecialist (via comando /agent) tiene mayor prioridad.
    const pinnedSpecialist = config.get<string>('activeSpecialist') ?? 'orchestrator';
    const specialistId: SpecialistId = forcedSpecialist
        ?? (pinnedSpecialist !== 'orchestrator' ? pinnedSpecialist as SpecialistId : routing.specialist);

    // === Cargar prompt del especialista ===
    const agentFilePaths = config.get<string[]>('agentFilePath') ?? [];
    const skillsFilePath = config.get<string>('skillsFilePath') ?? '';

    let specialistContent = loadSpecialistPrompt(specialistId, context.extensionPath);
    const customAgents = loadCustomAgents(agentFilePaths);
    const additionalSkills = loadAdditionalSkills(context.extensionPath, skillsFilePath);

    // Si hay flujo SDD activo, envolver el prompt del especialista con el contexto SDD
    if (isSddActive()) {
        const sddAgentContent = loadSpecialistPrompt('sdd', context.extensionPath);
        specialistContent = buildSddSystemPrompt(sddAgentContent || specialistContent);
    }

    // Construir system prompt completo
    const baseSystem = config.get<string>('systemPrompt') ?? 'Eres un asistente de programación experto.';
    const systemParts: string[] = [
        specialistContent || baseSystem,
        customAgents ? `\n\n---\n## Instrucciones personalizadas\n\n${customAgents}` : '',
        additionalSkills ? `\n\n---\n## Skills adicionales\n\n${additionalSkills}` : '',
        memoryContext ? `\n\n---\n${memoryContext}` : '',
        // workspace summary se añade aquí para que quede DENTRO del trim de presupuesto.
        // No se pasa a buildMessageHistory para evitar doble inclusión.
        getWorkspaceSummary() ? `\n\n${getWorkspaceSummary()}` : '',
    ].filter(Boolean);
    let systemPrompt = systemParts.join('');

    // === Trim del system prompt por presupuesto de chars ===
    if (systemPrompt.length > systemPromptBudgetChars) {
        log.warn('ChatParticipant', `System prompt excede budget: ${systemPrompt.length} > ${systemPromptBudgetChars} chars, recortando`);
        systemPrompt = systemPrompt.slice(0, systemPromptBudgetChars);
    }
    systemPrompt = systemPrompt.trimEnd();
    if (systemParts.join('').length > systemPrompt.length + 20) {
        systemPrompt += '\n\n*[Contexto adicional recortado para respetar la ventana de contexto del modelo]*';
    }

    log.info('ChatParticipant', 'System prompt trimmed', {
        originalChars: systemParts.join('').length,
        finalChars: systemPrompt.length,
        budgetChars: systemPromptBudgetChars,
        estimatedTokens: Math.ceil(systemPrompt.length / CHARS_PER_TOKEN),
    });
    // Log completo del system prompt en DEBUG para diagnóstico
    log.debug('ChatParticipant', 'System prompt content', { content: systemPrompt.slice(0, 3000) });

    // === Resolver referencias del workspace (#file, #selection, etc.) ===
    const refContext = await resolveReferences(request.references ?? []);

    // historyBudgetChars ya calculado arriba junto al resto del presupuesto de tokens.

    // === Guard de contexto: guardar en ia-recuerdo los mensajes que se van a descartar ===
    // Replicamos la lógica de recolección de buildMessageHistory para detectar el recorte
    // ANTES de que ocurra, y persistir esos mensajes en memoria antes de perderlos.
    const rawHistoryPreview: LmStudioChatMessage[] = [];
    for (const turn of chatContext.history.slice(-6)) {
        if (turn instanceof vscode.ChatRequestTurn) {
            rawHistoryPreview.push({ role: 'user', content: turn.prompt });
        } else if (turn instanceof vscode.ChatResponseTurn) {
            const txt = turn.response
                .filter((p): p is vscode.ChatResponseMarkdownPart =>
                    p instanceof vscode.ChatResponseMarkdownPart
                )
                .map(p => p.value.value)
                .join('');
            if (txt) { rawHistoryPreview.push({ role: 'assistant', content: txt }); }
        }
    }
    const tempQueue = [...rawHistoryPreview];
    const droppedMessages: LmStudioChatMessage[] = [];
    while (tempQueue.reduce((s, m) => s + m.content.length, 0) > historyBudgetChars && tempQueue.length > 0) {
        droppedMessages.push(tempQueue.shift()!);
    }

    if (droppedMessages.length > 0) {
        // Reutilizar mcpStatusEarly calculado al inicio del request
        if (mcpStatusEarly.memory && mcpStatusEarly.memoryUrl) {
            // ia-recuerdo disponible: guardar en segundo plano (sin bloquear la respuesta)
            void saveDroppedHistoryToMemory(droppedMessages, mcpStatusEarly.memoryUrl);
        } else {
            // ia-recuerdo no configurado: avisar al usuario antes de la respuesta
            stream.markdown(
                '> ⚠️ **Historial recortado — ia-recuerdo no detectado**\n>\n' +
                `> Se descartaron **${droppedMessages.length}** mensaje${droppedMessages.length !== 1 ? 's' : ''} ` +
                'del historial de conversación para caber en la ventana de contexto del modelo.\n>\n' +
                '> Instala **ia-recuerdo** para que el historial se guarde automáticamente:\n>\n' +
                '> ```json\n' +
                '> // En ~/.mcp.json → "servers":\n' +
                '> "ia-recuerdo": { "url": "http://localhost:7438/mcp", "type": "http" }\n' +
                '> ```\n\n'
            );
        }
    }

    // workspaceSummary ya está dentro de systemPrompt (trimmed). No se pasa de nuevo
    // para evitar doble inclusión que escapa al presupuesto de tokens.
    const messages = buildMessageHistory(
        chatContext,
        request.prompt + refContext,
        systemPrompt,
        undefined,
        historyBudgetChars
    );

    // Número de herramientas disponibles para mostrar en el header
    const availableTools = getAvailableTools();
    const toolsInfo = availableTools.length > 0
        ? ` · ${availableTools.length} herramienta${availableTools.length !== 1 ? 's' : ''} disponibles`
        : '';

    // Nombre del especialista para el header
    const specialistName = specialistId !== 'orchestrator'
        ? ` · 🎯 ${getSpecialistDisplayName(specialistId)}`
        : '';

    // Mostrar banner SDD si hay flujo activo
    if (isSddActive()) {
        const sddState = getSddState();
        const stepIdx = ['init','explore','design','spec','propose','tasks','apply','verify','archive'].indexOf(sddState.step) + 1;
        stream.markdown(`*📋 SDD — ${STEP_NAMES[sddState.step]} (${stepIdx}/9) · Tu respuesta avanzará al paso siguiente · \`/reset\` para cancelar*\n\n`);
    }

    try {
        // Contexto disponible para mostrar al usuario (incluye versión para diagnóstico)
        const ctxKTokens = Math.round(contextLength / 1000);
        stream.markdown(`*⚡ ${model.name} v${EXTENSION_VERSION} (LM Studio local)${specialistName}${toolsInfo} · 🧠 ${ctxKTokens}K ctx*\n\n`);

        await runAgentLoop(
            manager.lmStudio,
            model.id,
            messages,
            (text) => stream.markdown(text),
            (msg) => stream.progress(msg),
            request.toolInvocationToken,
            token,
            { temperature, maxTokens, contextLength, toolsMaxChars, toolsDetail: toolsMode !== 'off' ? toolsMode : undefined }
        );

        activeModelId = model.id;

        // === Auto-avanzar paso SDD tras respuesta del modelo ===
        // Avanzar siempre que SDD esté activo — incluye el paso init después de /sdd.
        // El sidebar se actualiza via onStateChange; no se emite texto para evitar duplicados.
        if (isSddActive() && !token.isCancellationRequested) {
            advanceSddStep(request.prompt);
        }

        // === Banner MCP (solo la primera vez o si está habilitado) ===
        if (showMcpBanner) {
            if (!mcpStatusEarly.orchestrator || !mcpStatusEarly.memory) {
                showMcpInstallBanner(stream, mcpStatusEarly);
            }
        }
    } catch (err) {
        if (!token.isCancellationRequested) {
            const errMsg = err instanceof Error ? err.message : String(err);
            stream.markdown(
                `\n\n❌ **Error:** ${errMsg}\n\n` +
                `Verifica que LM Studio esté corriendo y tenga el servidor local activo.\n` +
                `Ejecuta \`/status\` para ver el estado del servidor.`
            );
        }
    }

    // === ia-recuerdo: guardar resumen de sesión en background ===
    if (mcpStatusEarly.memory && mcpStatusEarly.memoryUrl && memorySessionId && memorySessionGoal) {
        void summarizeMemorySession(
            mcpStatusEarly.memoryUrl,
            memorySessionId,
            memorySessionGoal,
            `Respuesta generada con especialista ${specialistId}, modelo ${model.id}`,
            'copilot-lmstudio'
        );
    }

    return { metadata: { command: '', modelUsed: model.id, specialist: specialistId } };
}

function buildMessageHistory(
    chatContext: vscode.ChatContext,
    currentPrompt: string,
    systemPrompt: string,
    workspaceSummary?: string,
    maxHistoryChars: number = 12_000
): LmStudioChatMessage[] {
    const messages: LmStudioChatMessage[] = [];

    // El system prompt incluye el contexto del workspace si está disponible
    const baseSystem = [
        systemPrompt || 'Eres un asistente de programación experto.',
        workspaceSummary ? `\n${workspaceSummary}` : '',
    ].filter(Boolean).join('');

    messages.push({ role: 'system', content: baseSystem });

    // Recopilar los últimos 6 turnos del historial
    const rawHistory: LmStudioChatMessage[] = [];
    for (const turn of chatContext.history.slice(-6)) {
        if (turn instanceof vscode.ChatRequestTurn) {
            rawHistory.push({ role: 'user', content: turn.prompt });
        } else if (turn instanceof vscode.ChatResponseTurn) {
            const responseText = turn.response
                .filter((p): p is vscode.ChatResponseMarkdownPart =>
                    p instanceof vscode.ChatResponseMarkdownPart
                )
                .map(p => p.value.value)
                .join('');
            if (responseText) {
                rawHistory.push({ role: 'assistant', content: responseText });
            }
        }
    }

    // Guard de contexto: eliminamos mensajes más antiguos hasta no superar el límite.
    // Aproximación: 4 chars ≈ 1 token. maxHistoryChars se calcula dinámicamente en
    // función del context length real del modelo cargado en LM Studio.
    while (rawHistory.reduce((s, m) => s + m.content.length, 0) > maxHistoryChars && rawHistory.length > 0) {
        rawHistory.shift();
    }
    messages.push(...rawHistory);

    messages.push({ role: 'user', content: currentPrompt });
    return messages;
}

