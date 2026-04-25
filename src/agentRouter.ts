/**
 * agentRouter.ts — Detecta el especialista más adecuado según el contexto del workspace.
 *
 * Analiza:
 *  - Archivos abiertos y lenguajes activos
 *  - Palabras clave en el prompt
 *  - Extensiones de archivos en el workspace
 *  - Flags explícitos (/agent azure, etc.)
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export type SpecialistId =
    | 'orchestrator'
    | 'azure'
    | 'blazor-server'
    | 'blazor-wasm'
    | 'maui'
    | 'mudblazor'
    | 'csharp'
    | 'clean-arch'
    | 'microservices'
    | 'minimal-api'
    | 'infrastructure'
    | 'frontend'
    | 'angular'
    | 'django-drf'
    | 'sdd'
    | 'code-review'
    | 'unit-testing'
    | 'playwright'
    | 'pytest'
    | 'web-security'
    | 'typescript'
    | 'solid-principles'
    | 'ai-sdk'
    | 'github-pr'
    | 'interface-programming'
    | 'jira'
    | 'go';

/** Lista de todos los IDs de especialista disponibles (excluye 'orchestrator' y 'sdd') */
export const ALL_SPECIALIST_IDS: SpecialistId[] = [
    'azure', 'blazor-server', 'blazor-wasm', 'maui', 'mudblazor',
    'csharp', 'clean-arch', 'microservices', 'minimal-api', 'infrastructure',
    'frontend', 'angular', 'django-drf', 'code-review', 'unit-testing',
    'playwright', 'pytest', 'web-security', 'typescript', 'solid-principles',
    'ai-sdk', 'github-pr', 'interface-programming', 'jira', 'go',
];

export interface RoutingResult {
    specialist: SpecialistId;
    confidence: 'high' | 'medium' | 'low';
    reason: string;
}

// Palabras clave que activan cada especialista (en el prompt del usuario)
const PROMPT_KEYWORDS: Record<SpecialistId, string[]> = {
    orchestrator: [],
    azure: ['azure', 'bicep', 'arm template', 'aks', 'key vault', 'logic app', 'function app', 'apim', 'devops pipeline', 'storage account'],
    'blazor-server': ['blazor server', 'signalr', 'circuito', 'circuit', '@rendermode interactiveserver', 'server-side blazor'],
    'blazor-wasm': ['blazor wasm', 'blazor webassembly', '@rendermode interactivewebassembly', 'pwa blazor', 'offline blazor'],
    maui: ['maui', 'xaml', 'xamarin', 'net-ios', 'net-android', 'mobile app', 'shell navigation', 'mvvm maui'],
    mudblazor: ['mudblazor', 'mudtextfield', 'muddatagrid', 'mudbutton', 'muddialog', 'mudtheme', 'mud component'],
    csharp: ['c#', 'csharp', 'dotnet', '.net', 'record', 'pattern matching', 'linq', 'async await', 'nullable', 'span<', 'valuetask'],
    'clean-arch': ['clean architecture', 'ddd', 'cqrs', 'mediator', 'mediatR', 'aggregate', 'domain event', 'value object', 'use case', 'repository pattern'],
    microservices: ['microservicio', 'microservice', 'grpc', 'rabbitmq', 'masstransit', 'polly', 'yarp', 'api gateway', 'outbox', 'eventbus', 'saga'],
    'minimal-api': ['minimal api', 'mapget', 'mappost', 'iendpoint', 'typedresults', 'server-sent events', 'sse', 'openapi 3.1', 'endpoint feature slice', 'addvalidation'],
    infrastructure: ['proxmox', 'lxc', 'hyper-v', 'docker', 'compose', 'linux', 'systemd', 'nftables', 'iis', 'windows server', 'vm', 'terraform proxmox'],
    frontend: ['react', 'next.js', 'nextjs', 'tailwind', 'tsx', 'jsx', 'component', 'hook', 'suspense', 'server action', 'usestate'],
    angular: ['angular', 'component angular', 'signals', 'signal()', 'inject()', 'standalone component', 'ngfor', 'ngif', '@if ', '@for ', 'control flow angular', 'angular forms', 'reactive forms'],
    'django-drf': ['django', 'drf', 'viewset', 'serializer', 'python api', 'rest framework', 'modelviewset', 'filterset', 'django filter', 'django rest'],
    sdd: ['sdd', 'spec driven', 'especificación', 'flujo sdd', 'diseño de feature', 'nuevo proyecto', 'nueva feature', 'quiero crear', 'quiero construir', 'cómo empezar', 'desde cero', 'arquitectura de', 'quiero hacer un sistema'],
    'code-review': ['review', 'revisar', 'código a revisar', 'check this code', 'que tal este código', 'mejoras al código'],
    'unit-testing': ['unit test', 'test unitario', 'xunit', 'nsubstitute', 'fluentassertions', 'coverlet', 'cobertura', 'coverage', 'webapplicationfactory', 'integration test', 'bunit', 'fact', 'theory', 'mock', 'stub', 'coverage report'],
    playwright: ['playwright', 'e2e test', 'end to end', 'page object', 'getbyrole', 'getbylabel', 'spec.ts playwright', '.spec.ts'],
    pytest: ['pytest', 'fixtures pytest', 'conftest', 'python test', '@pytest.mark', 'parametrize', 'pytest fixture', 'asyncmock', 'magicmock'],
    'web-security': ['owasp', 'seguridad web', 'xss', 'sql injection', 'inyección sql', 'cors', 'csrf', 'auth policy', 'rate limit', 'hsts', 'security header', 'content security policy'],
    typescript: ['typescript tipos', 'const types', 'satisfies typescript', 'type guard', 'discriminated union', 'unknown typescript', 'utility types', 'exactoptional', 'mapped types', 'keyof typeof'],
    'solid-principles': ['solid', 'srp', 'ocp', 'lsp', 'isp', 'dip', 'dependency inversion', 'single responsibility', 'open closed', 'liskov', 'interface segregation', 'principios solid'],
    'ai-sdk': ['ai sdk', 'vercel ai', 'usechat', 'streaming ai', 'ai chat', 'openai sdk', 'generateobject', 'generatetext', 'streamtext', 'tool calling', '@ai-sdk'],
    'github-pr': ['pull request', 'github pr', 'gh pr create', 'conventional commit', 'commit message', 'branch naming', 'pr description'],
    'interface-programming': ['interfaz', 'interface programming', 'irepository', 'iemailsender', 'coding to interface', 'abstracción', 'decorator pattern', 'scrutor', 'null object pattern', 'inject abstraction'],
    jira: ['jira', 'ticket', 'epic jira', 'historia de usuario', 'user story', 'jira task', 'criterios de aceptación', 'acceptance criteria', 'bug ticket', 'jira epic'],
    go: ['golang', 'go lang', 'go module', 'go.mod', 'goroutine', 'channel go', 'errgroup', 'go interface', 'net/http go', 'go test', 'go build', 'gorm', 'gin go', 'echo go', 'fiber go', 'go router', 'context.WithTimeout', 'errors.Is', 'errors.As', 'fmt.Errorf', 'go generics'],
};

// Extensiones/archivos del workspace que activan especialistas
const FILE_PATTERNS: Array<{ pattern: RegExp; specialist: SpecialistId; weight: number }> = [
    { pattern: /\.cshtml$|\.razor$/i, specialist: 'blazor-server', weight: 2 },
    { pattern: /Platforms\/(Android|iOS)/i, specialist: 'maui', weight: 3 },
    { pattern: /MudBlazor/i, specialist: 'mudblazor', weight: 3 },
    { pattern: /\.bicep$|arm-template/i, specialist: 'azure', weight: 3 },
    { pattern: /docker-compose|Dockerfile|\.service$|proxmox/i, specialist: 'infrastructure', weight: 2 },
    { pattern: /Application\/(Commands|Queries)\//i, specialist: 'clean-arch', weight: 3 },
    { pattern: /MassTransit|gRPC|\.proto$/i, specialist: 'microservices', weight: 3 },
    { pattern: /\.(tsx|jsx)$/, specialist: 'frontend', weight: 2 },
    { pattern: /next\.config\.(js|ts|mjs)$/i, specialist: 'frontend', weight: 3 },
    { pattern: /\.cs$/, specialist: 'csharp', weight: 1 },
    { pattern: /Tests?\.csproj$|\.Tests\/|xunit\.runner/i, specialist: 'unit-testing', weight: 3 },
    { pattern: /coverlet|FluentAssertions|NSubstitute/i, specialist: 'unit-testing', weight: 2 },
    { pattern: /playwright\.config\.(ts|js)$/i, specialist: 'playwright', weight: 3 },
    { pattern: /\.spec\.ts$/i, specialist: 'playwright', weight: 1 },
    { pattern: /conftest\.py$|pytest\.ini$|pyproject\.toml$/i, specialist: 'pytest', weight: 2 },
    { pattern: /angular\.json$|app\.component\.ts$/i, specialist: 'angular', weight: 3 },
    { pattern: /\.component\.ts$|\.service\.ts$|environment\.ts$/i, specialist: 'angular', weight: 2 },
    { pattern: /requirements\.txt$|settings\.py$|urls\.py$|serializers\.py$/i, specialist: 'django-drf', weight: 3 },
    { pattern: /tsconfig\.json$/, specialist: 'typescript', weight: 1 },
    { pattern: /go\.mod$|go\.sum$/i, specialist: 'go', weight: 3 },
    { pattern: /\.go$/, specialist: 'go', weight: 2 },
    { pattern: /main\.go$/, specialist: 'go', weight: 3 },
];

/**
 * Detecta el especialista más adecuado según el prompt y el contexto del workspace.
 */
export function detectSpecialist(
    prompt: string,
    _extensionPath: string
): RoutingResult {
    const lowerPrompt = prompt.toLowerCase();

    // 1. Comandos explícitos del usuario: `/agent <id>` o `@localai /agent azure`
    const explicitMatch = lowerPrompt.match(/\/agent\s+(\w[\w-]*)/);
    if (explicitMatch) {
        const requested = explicitMatch[1] as SpecialistId;
        if (requested in PROMPT_KEYWORDS) {
            return { specialist: requested, confidence: 'high', reason: 'Especificado explícitamente con /agent' };
        }
    }

    // 2. Score por palabras clave en el prompt
    const scores: Partial<Record<SpecialistId, number>> = {};

    for (const [specialist, keywords] of Object.entries(PROMPT_KEYWORDS) as [SpecialistId, string[]][]) {
        for (const kw of keywords) {
            if (lowerPrompt.includes(kw.toLowerCase())) {
                scores[specialist] = (scores[specialist] ?? 0) + 1;
            }
        }
    }

    // 3. Score por archivos del workspace
    const workspaceFiles = getWorkspaceFiles();
    for (const filePath of workspaceFiles) {
        for (const { pattern, specialist, weight } of FILE_PATTERNS) {
            if (pattern.test(filePath)) {
                scores[specialist] = (scores[specialist] ?? 0) + weight;
            }
        }
    }

    // 4. Score por archivo activo en el editor
    const activeFile = vscode.window.activeTextEditor?.document.uri.fsPath ?? '';
    if (activeFile) {
        for (const { pattern, specialist, weight } of FILE_PATTERNS) {
            if (pattern.test(activeFile)) {
                scores[specialist] = (scores[specialist] ?? 0) + (weight * 2); // mayor peso al archivo activo
            }
        }
    }

    // 5. Determinar ganador
    const ranked = Object.entries(scores)
        .filter(([, score]) => score > 0)
        .sort(([, a], [, b]) => b - a) as [SpecialistId, number][];

    if (ranked.length === 0) {
        return { specialist: 'orchestrator', confidence: 'low', reason: 'Sin contexto específico detectado' };
    }

    const [topSpecialist, topScore] = ranked[0];
    const confidence: 'high' | 'medium' | 'low' =
        topScore >= 4 ? 'high' :
        topScore >= 2 ? 'medium' : 'low';

    // Si la confianza es baja y el runner-up tiene score cercano,
    // usar el orquestador para decidir
    if (confidence === 'low' && ranked.length > 1 && ranked[1][1] >= topScore - 1) {
        return { specialist: 'orchestrator', confidence: 'low', reason: 'Contexto ambiguo — usando orquestador' };
    }

    return {
        specialist: topSpecialist,
        confidence,
        reason: `Detectado por palabras clave y contexto del workspace (score: ${topScore})`,
    };
}

/**
 * Devuelve una muestra de rutas de archivos del workspace para análisis de patrones.
 */
function getWorkspaceFiles(): string[] {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders) { return []; }

    const files: string[] = [];
    for (const folder of folders) {
        try {
            collectFilesRecursive(folder.uri.fsPath, files, 0, 3);
        } catch {
            // Ignorar errores de lectura
        }
    }
    return files;
}

function collectFilesRecursive(dir: string, results: string[], depth: number, maxDepth: number): void {
    if (depth > maxDepth || results.length > 200) { return; }

    let entries: string[];
    try {
        entries = fs.readdirSync(dir);
    } catch {
        return;
    }

    for (const entry of entries) {
        if (entry.startsWith('.') || entry === 'node_modules' || entry === 'bin' || entry === 'obj' || entry === 'out') { continue; }
        const fullPath = path.join(dir, entry);
        try {
            const stat = fs.statSync(fullPath);
            if (stat.isDirectory()) {
                collectFilesRecursive(fullPath, results, depth + 1, maxDepth);
            } else if (!/\.(md|txt)$/i.test(entry)) {
                // Excluir markdown y texto plano — no son señales de especialistas de código
                results.push(fullPath);
            }
        } catch {
            // Ignorar
        }
    }
}

/**
 * Carga el contenido del sistema de instrucciones para un especialista dado.
 * Busca primero en la ruta personalizada del usuario, luego en los assets bundleados.
 */
export function loadSpecialistPrompt(
    specialistId: SpecialistId,
    extensionPath: string,  // eslint-disable-line @typescript-eslint/no-unused-vars
    userCustomPath?: string
): string {
    // 1. Ruta personalizada del usuario
    if (userCustomPath) {
        try {
            if (fs.existsSync(userCustomPath)) {
                return fs.readFileSync(userCustomPath, 'utf8');
            }
        } catch {
            // Fall through to bundled
        }
    }

    // 2. Asset bundleado por ID de especialista
    const assetPath = path.join(extensionPath, 'assets', 'agents', `${specialistId}.md`);
    try {
        if (fs.existsSync(assetPath)) {
            return fs.readFileSync(assetPath, 'utf8');
        }
    } catch {
        // Fall through to default
    }

    return '';
}

/**
 * Carga el contenido de skills adicionales para inyectar como contexto.
 */
export function loadAdditionalSkills(
    _extensionPath: string,
    userSkillsPath?: string
): string {
    // 1. Ruta personalizada del usuario
    if (userSkillsPath) {
        try {
            if (fs.existsSync(userSkillsPath)) {
                return fs.readFileSync(userSkillsPath, 'utf8');
            }
        } catch {
            // Fall through
        }
    }
    return '';
}

/**
 * Carga y concatena el contenido de múltiples archivos .md de agente personalizados.
 * Se aplica a todos los especialistas, no solo al orchestrator.
 */
export function loadCustomAgents(paths: string[]): string {
    const contents: string[] = [];
    for (const p of paths) {
        if (!p) { continue; }
        try {
            if (fs.existsSync(p)) {
                contents.push(fs.readFileSync(p, 'utf8'));
            }
        } catch {
            // Ignorar archivos no legibles
        }
    }
    return contents.join('\n\n---\n\n');
}

/**
 * Devuelve el nombre legible del especialista.
 */
export function getSpecialistDisplayName(id: SpecialistId): string {
    const names: Record<SpecialistId, string> = {
        orchestrator: 'Orquestador',
        azure: 'Azure & Cloud',
        'blazor-server': 'Blazor Server',
        'blazor-wasm': 'Blazor WASM',
        maui: '.NET MAUI',
        mudblazor: 'MudBlazor',
        csharp: 'C# / .NET',
        'clean-arch': 'Clean Architecture',
        microservices: 'Microservicios',
        'minimal-api': 'Minimal APIs',
        infrastructure: 'Infraestructura',
        frontend: 'Frontend (React/Next)',
        angular: 'Angular',
        'django-drf': 'Django REST Framework',
        sdd: 'SDD Workflow',
        'code-review': 'Code Review',
        'unit-testing': 'Unit Testing',
        playwright: 'Playwright E2E',
        pytest: 'Pytest',
        'web-security': 'Web Security',
        typescript: 'TypeScript',
        'solid-principles': 'SOLID Principles',
        'ai-sdk': 'AI SDK 5',
        'github-pr': 'GitHub PR',
        'interface-programming': 'Interface Programming',
        jira: 'Jira',
        go: 'Go',
    };
    return names[id] ?? id;
}
