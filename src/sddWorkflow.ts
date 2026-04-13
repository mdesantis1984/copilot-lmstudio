/**
 * sddWorkflow.ts — Estado y lógica del flujo SDD (Spec-Driven Development).
 *
 * Maneja los 9 pasos del workflow SDD de forma guiada:
 *   Init → Explore → Design → Spec → Propose → Tasks → Apply → Verify → Archive
 */

import * as vscode from 'vscode';

export type SddStep =
    | 'idle'
    | 'init'
    | 'explore'
    | 'design'
    | 'spec'
    | 'propose'
    | 'tasks'
    | 'apply'
    | 'verify'
    | 'archive'
    | 'completed';

export interface SddState {
    step: SddStep;
    projectName: string;
    projectGoal: string;
    startedAt: Date | null;
    context: Record<string, string>; // Acumulado de cada paso
    taskList: SddTask[];
    currentTaskIndex: number;
}

export interface SddTask {
    id: string;
    track: string;
    description: string;
    completed: boolean;
}

/** Número del paso dentro del flujo (1-based) */
const STEP_ORDER: SddStep[] = [
    'idle', 'init', 'explore', 'design', 'spec',
    'propose', 'tasks', 'apply', 'verify', 'archive',
];

/** Nombre legible de cada paso */
export const STEP_NAMES: Record<SddStep, string> = {
    idle: 'Sin flujo activo',
    init: '1. Init',
    explore: '2. Explore',
    design: '3. Design',
    spec: '4. Spec',
    propose: '5. Propose',
    tasks: '6. Tasks',
    apply: '7. Apply',
    verify: '8. Verify',
    archive: '9. Archive',
    completed: 'Completado',
};

/** Descripción breve de qué hace cada paso */
const STEP_PROMPTS: Record<SddStep, string> = {
    idle: '',
    init: `Paso 1/9 — Init.

**Objetivo del usuario**: {projectGoal}

⚠️ IMPORTANTE: Los datos del workspace ya están en este mensaje (exploración automática previa al LLM).
USA ESOS DATOS DIRECTAMENTE para completar el Init. NO uses herramientas de exploración — ya tienes todo lo necesario.

Generá el documento Init ÚNICAMENTE basado en los datos provistos, con este formato exacto:

## SDD Init — {projectName}
- **Fecha**: {date}
- **Objetivo**: [en una línea, derivado del pedido]
- **Stack detectado**: [extrae del package.json / tsconfig.json / csproj encontrado — NUNCA inventar]
- **Estructura principal**: [carpetas/archivos clave de la exploración]
- **Constraints**: [limitaciones reales del código encontrado]
- **Definición de "Done"**: [criterio claro derivado del objetivo]

⛔ STOP — Terminá aquí. NO continúes al paso 2 ni menciones "Explore".
Terminá EXACTAMENTE con esta línea: "¿Estos datos son correctos? Confirma para continuar."`,
    explore: `Paso 2 — Explore: Analizar el contexto y requisitos en profundidad.

Para entender bien el problema:

1. ¿Es un sistema nuevo o estamos modificando algo existente?
2. ¿Qué tecnologías ya están definidas o restringidas?
3. ¿Cuáles son los 3 casos de uso principales?
4. ¿Existen usuarios o stakeholders con expectativas específicas?

Detallá lo que puedas y voy a armar el documento de Contexto.`,
    design: `Paso 3 — Design: Diseño de alto nivel.

Voy a proponer:
- Arquitectura de componentes (diagrama ASCII)
- Decisiones técnicas clave con justificación
- Interfaces principales entre componentes
- Modelo de datos preliminar

Respondé o ajustá el diseño propuesto.`,
    spec: `Paso 4 — Spec: Especificación detallada (el contrato).

Voy a escribir la spec formal con:
- Inputs y Outputs con tipos
- Business Rules numeradas (BR-XX)
- Error Cases (EC-XX)
- Requisitos No Funcionales (performance, seguridad)

Esta spec es el contrato que guiará la implementación.`,
    propose: `Paso 5 — Propose: Propuesta de implementación concreta.

Voy a detallar:
- Lista completa de archivos a crear/modificar
- Código esqueleto de los componentes principales
- Schema de BD o contratos de API si aplica

¿Avanzamos con la implementación?`,
    tasks: `Paso 6 — Tasks: Descomposición en tareas atómicas.

Voy a crear el task board organizado por track (Infrastructure, Application, Presentation, Tests).
Cada tarea será atómica, estimable y con dependencias claras.`,
    apply: `Paso 7 — Apply: Implementación task por task.

Vamos task por task. Te muestro el código completo para cada una.
Confirmame cuando esté aplicada para avanzar a la siguiente.`,
    verify: `Paso 8 — Verify: Verificación sistemática.

Voy a revisar contra la Spec (paso 4):
- ¿Todos los Business Rules están implementados?
- ¿Los Error Cases tienen manejo?
- ¿Las NFRs se cumplen?
- ¿Hay tests para los casos críticos?`,
    archive: `Paso 9 — Archive: Documentar para el futuro.

Voy a generar el documento de Archive con:
- Decisiones técnicas tomadas y por qué
- Deuda técnica identificada
- Aprendizajes para próximas features
- Links a PRs y tickets`,
    completed: `✅ **Flujo SDD completado.**\n\nTodos los pasos del workflow han sido completados. El documento de Archive resume las decisiones y aprendizajes del proyecto.`,
};

/** Instancia singleton del estado SDD (una sesión a la vez) */
let _state: SddState = createInitialState();

/** Listeners para notificar cambios de estado (usado por el TreeView) */
const _stateListeners: Array<(state: SddState) => void> = [];

export function onStateChange(listener: (state: SddState) => void): vscode.Disposable {
    _stateListeners.push(listener);
    return new vscode.Disposable(() => {
        const idx = _stateListeners.indexOf(listener);
        if (idx >= 0) { _stateListeners.splice(idx, 1); }
    });
}

function notifyListeners(): void {
    for (const listener of _stateListeners) {
        listener({ ..._state });
    }
}

function createInitialState(): SddState {
    return {
        step: 'idle',
        projectName: '',
        projectGoal: '',
        startedAt: null,
        context: {},
        taskList: [],
        currentTaskIndex: 0,
    };
}

/**
 * Devuelve el estado SDD actual.
 */
export function getSddState(): SddState {
    return { ..._state };
}

/**
 * Verifica si hay un flujo SDD activo.
 */
export function isSddActive(): boolean {
    return _state.step !== 'idle' && _state.step !== 'completed';
}

/**
 * Inicia el flujo SDD. Retorna el prompt de la pregunta inicial para el modelo.
 */
export function startSdd(projectGoalFromUser?: string): string {
    _state = createInitialState();
    _state.step = 'init';
    _state.startedAt = new Date();

    if (projectGoalFromUser) {
        _state.projectGoal = projectGoalFromUser;
        _state.projectName = extractProjectName(projectGoalFromUser);
    }

    notifyListeners();

    if (!projectGoalFromUser) {
        return (
            '╔══════════════════════════════════════════════╗\n' +
            '║  SDD Workflow — Bienvenido al flujo guiado    ║\n' +
            '╚══════════════════════════════════════════════╝\n\n' +
            'Para comenzar el flujo SDD, necesito entender el objetivo principal.\n\n' +
            '**¿Cuál es el problema que querés resolver o la feature que querés construir?**\n\n' +
            '*Describila con el mayor detalle posible — el flujo se adaptará automáticamente.*'
        );
    }

    return buildStepPrompt('init');
}

/**
 * Avanza al siguiente paso del flujo SDD.
 * Retorna el prompt del nuevo paso.
 */
export function advanceSddStep(userResponse?: string): string {
    if (_state.step === 'idle') {
        return startSdd(userResponse);
    }

    // Guardar la respuesta del usuario en el contexto del paso actual
    if (userResponse) {
        _state.context[_state.step] = userResponse;

        // Si estamos en init y no tenemos nombre/objetivo, extraer del primer mensaje
        if (_state.step === 'init' && !_state.projectGoal) {
            _state.projectGoal = userResponse;
            _state.projectName = extractProjectName(userResponse);
        }
    }

    const currentIndex = STEP_ORDER.indexOf(_state.step);
    if (currentIndex === -1 || currentIndex >= STEP_ORDER.length - 1) {
        _state.step = 'completed';
        notifyListeners();
        return STEP_PROMPTS.completed;
    }

    _state.step = STEP_ORDER[currentIndex + 1];
    notifyListeners();
    return buildStepPrompt(_state.step);
}

/**
 * Resetea el flujo SDD (cancelar / empezar de nuevo).
 */
export function resetSdd(): void {
    _state = createInitialState();
    notifyListeners();
}

/**
 * Registra que una tarea del paso Apply fue completada.
 */
export function markTaskCompleted(taskId: string): void {
    const task = _state.taskList.find(t => t.id === taskId);
    if (task) {
        task.completed = true;
        notifyListeners();
    }
}

/**
 * Construye el header + prompt para un paso del flujo.
 */
function buildStepPrompt(step: SddStep): string {
    const totalSteps = STEP_ORDER.length - 1; // excluye solo 'idle' ('completed' no está en STEP_ORDER)
    const stepIndex = STEP_ORDER.indexOf(step); // idle=0, init=1 ... archive=9

    const header =
        `╔═══════════════════════════════════════════════════╗\n` +
        `║  SDD Workflow — Paso ${stepIndex}/${totalSteps}: ${STEP_NAMES[step].padEnd(23)}║\n` +
        `╚═══════════════════════════════════════════════════╝\n\n`;

    const prompt = STEP_PROMPTS[step]
        .replace('{projectName}', _state.projectName || 'Sin nombre')
        .replace('{projectGoal}', _state.projectGoal || '')
        .replace('{date}', new Date().toLocaleDateString('es-ES'));

    return header + prompt;
}

/**
 * Extrae un nombre de proyecto aproximado de la descripción del usuario.
 * Si la descripción parece una pregunta/pedido, usa el nombre del workspace.
 */
function extractProjectName(description: string): string {
    // Si parece un pedido/pregunta (verbos iniciales comunes), usar el workspace
    const isRequest = /^(necesito|quiero|ayuda|verifica|analiza|revisa|crea|genera|haz|podés|puedes|dame|muestra)/i.test(description.trim());
    if (isRequest) {
        const folders = (typeof vscode !== 'undefined')
            ? vscode.workspace.workspaceFolders
            : undefined;
        if (folders && folders.length > 0) {
            return folders[0].name;
        }
    }
    // Buscar patrones comunes: "sistema de X", "app de X", "módulo X"
    const match = description.match(/(?:sistema|app|aplicación|módulo|feature|servicio)\s+(?:de\s+)?([A-Za-zÀ-ÿ\s]+?)(?:\s+que|\s+para|\.|,|$)/i);
    if (match?.[1]) {
        return match[1].trim().slice(0, 50);
    }
    // Si no, tomar las primeras palabras significativas (saltando verbos comunes)
    const words = description.split(/\s+/).filter(w => w.length > 3);
    return words.slice(0, 4).join(' ') || description.slice(0, 40);
}

/**
 * Genera el prompt de sistema para el especialista SDD.
 * Este prompt incluye el contexto acumulado de los pasos anteriores.
 */
export function buildSddSystemPrompt(baseAgentContent: string): string {
    const state = getSddState();

    if (state.step === 'idle') {
        return baseAgentContent;
    }

    // Obtener rutas absolutas del workspace para que el LLM no adivine
    const workspacePaths = vscode.workspace.workspaceFolders
        ?.map(f => `${f.name}: ${f.uri.fsPath}`)
        .join(', ') ?? 'no detectado';

    const contextSnippets: string[] = [];
    for (const [step, content] of Object.entries(state.context)) {
        contextSnippets.push(`### ${STEP_NAMES[step as SddStep]}\n${content}`);
    }

    const contextBlock = contextSnippets.length > 0
        ? `\n\n## Contexto SDD acumulado\n\n${contextSnippets.join('\n\n')}`
        : '';

    return (
        baseAgentContent +
        `\n\n---\n## SDD Workflow en progreso\n\n` +
        `- **Proyecto**: ${state.projectName || 'Sin definir'}\n` +
        `- **Objetivo**: ${state.projectGoal || 'Sin definir'}\n` +
        `- **Paso actual**: ${STEP_NAMES[state.step]}\n` +
        `- **Workspace paths** (usa ESTAS rutas en tus herramientas): ${workspacePaths}\n` +
        contextBlock +
        `\n\n## Instrucciones para el paso actual\n\n${buildStepPrompt(state.step)}` +
        '\n\nContinúa el flujo SDD según el paso actual. Sé específico y guía al usuario paso a paso.'
    );
}
