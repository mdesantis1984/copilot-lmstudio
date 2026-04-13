# Copilot Local Models — Zero Cost AI

[![VS Code](https://img.shields.io/badge/VS%20Code-1.95%2B-blue?logo=visualstudiocode)](https://code.visualstudio.com/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![.NET](https://img.shields.io/badge/.NET-10%20LTS-purple?logo=dotnet)](https://dotnet.microsoft.com/)

Potencia GitHub Copilot con **modelos de IA locales de coste cero** usando [LM Studio](https://lmstudio.ai) como motor principal. Conecta cualquier modelo GGUF directamente a VS Code — sin API keys, sin facturación, sin enviar código a servidores externos.

---

## ¿Qué hace este plugin?

| Característica | Detalle |
|---|---|
| 🤖 **Modelos en el picker** | Los modelos de LM Studio aparecen junto a GPT-4o en el selector de modelos de Copilot |
| 💬 **`@localai` en Chat** | Usa `@localai` en Copilot Chat para chatear con modelos locales y agentes especialistas |
| 🔄 **Streaming** | Respuestas streameadas en tiempo real, igual que los modelos cloud |
| 🔒 **Privacidad total** | El código nunca sale de tu máquina |
| 💸 **Coste cero** | Sin API keys, sin tokens de pago, sin límites |
| 🎯 **Motor principal: LM Studio** | API OpenAI-compatible en `localhost:1234` — compatibe con cualquier modelo GGUF |
| 🧠 **27 Agentes Especialistas** | Sistema de agentes especializados para .NET, web, Python, seguridad y más |

---

## Agentes Especialistas (.NET 10 Ready)

El plugin incluye 26 agentes especializados. Se activan automáticamente según el contexto del workspace o mediante menciones explícas (`@azure`, `@csharp`, etc.):

| Agente | Especialidad |
|--------|-------------|
| `orchestrator` | Agente principal — enruta a especialistas automáticamente |
| `csharp` | **C# 12/13/14** + **.NET 10 LTS** (extension members, field keyword, implicit Span) |
| `blazor-server` | Blazor Server .NET 10 — `[PersistentState]`, circuito persistente, ReconnectModal |
| `blazor-wasm` | Blazor WASM .NET 10 — fingerprinting, ResourcePreloader, HttpClient streaming |
| `maui` | .NET MAUI 10 — deprecaciones ListView/MessagingCenter, SafeAreaEdges |
| `mudblazor` | Componentes MudBlazor, themes, data grids, formularios |
| `clean-arch` | Clean Architecture, CQRS, MediatR, DDD |
| `microservices` | Microservicios, gRPC, MassTransit, Polly, YARP |
| `minimal-api` | Minimal APIs .NET 10, IEndpoint, TypedResults, OpenAPI 3.1, SSE |
| `azure` | Azure Cloud, Bicep, AKS, Functions, DevOps |
| `frontend` | React 19, Next.js 15, Tailwind 4, Zustand 5 |
| `angular` | Angular 19+, signals, standalone, inject(), reactive forms |
| `django-drf` | Django REST Framework, ViewSet, Serializers, Filters |
| `infrastructure` | Docker, Proxmox, Linux, systemd, redes |
| `sdd` | Spec-Driven Development — flujo completo 9 pasos |
| `unit-testing` | **xUnit v3, NSubstitute, Coverlet** — cobertura mínima **60%** |
| `playwright` | Playwright E2E, MCP workflow, Page Object Model |
| `pytest` | Pytest, fixtures/scope, mocking, parametrize, cobertura Python |
| `web-security` | OWASP Top 10, ASP.NET Core security, headers, CORS, rate limiting |
| `typescript` | TypeScript estricto, const types, type guards, utility types |
| `solid-principles` | SOLID en C# — SRP, OCP, LSP, ISP, DIP con ejemplos |
| `ai-sdk` | Vercel AI SDK 5, useChat, streaming, generateObject, tool calling |
| `github-pr` | Conventional commits, PR descriptions, gh CLI |
| `interface-programming` | DI, abstracciones, decorators, Scrutor, Null Object pattern |
| `jira` | Jira tasks (bug/feature), epics, criterios de aceptación |
| `go` | Go 1.22+ — project structure, error handling, goroutines, HTTP, table-driven tests |
| `code-review` | Review de código, convenciones, seguridad, performance |

### Unit Testing — 60% Coverage Enforcement

El agente `unit-testing` guía a establecer cobertura mínima obligatoria:

```bash
# Ejecutar tests con threshold de cobertura
dotnet test --collect:"XPlat Code Coverage" /p:Threshold=60
```

```xml
<!-- En .csproj del proyecto de tests -->
<CollectCoverage>true</CollectCoverage>
<Threshold>60</Threshold>
<ThresholdType>line,branch,method</ThresholdType>
```

Stack recomendado: **xUnit v3** + **NSubstitute** (evita licensing de Moq v5+) + **FluentAssertions** + **bUnit** (componentes Blazor).

---

## Requisitos Previos

### Instalar LM Studio (motor principal)

Descarga desde **[lmstudio.ai](https://lmstudio.ai)** — disponible para Windows, macOS y Linux.

**Pasos de configuración:**

1. Instalar LM Studio
2. Descargar un modelo desde la pestaña **Discover** (ver modelos recomendados abajo)
3. Ir a la pestaña **Developer** → activar **"Start Server"** (puerto `1234` por defecto)
4. Verificar que el servidor responde en `http://localhost:1234/v1/models`

LM Studio expone una API 100% compatible con OpenAI — el plugin la usa directamente sin ninguna configuración extra.

---

## Uso

### 1. Chat Participant `@localai`

Escribe `@localai` en Copilot Chat para activar el participante con agentes especializados:

```
@localai explica este código
@localai /models
@localai /switch qwen2.5-coder:7b
@localai /status
@localai /sdd
@localai /agent csharp
```

**Comandos disponibles:**

| Comando | Descripción |
|---------|-------------|
| `/models` | Lista los modelos cargados en LM Studio |
| `/switch <modelo>` | Cambia el modelo activo para la sesión |
| `/status` | Verifica el estado del servidor LM Studio |
| `/sdd` | Inicia el flujo Spec-Driven Development (9 pasos) |
| `/agent <id>` | Fuerza un especialista concreto (`/agent csharp`, `/agent azure`, etc.) |
| `/next` | Avanza al siguiente paso del flujo SDD activo |
| `/reset` | Cancela el flujo SDD activo |

### 2. Selector de Modelos de Copilot

Los modelos cargados en LM Studio aparecen automáticamente en el **selector desplegable del chat de Copilot** (junto a GPT-4o, Claude, etc.). Solo selecciona uno y úsalo normalmente — sin ningún comando adicional.

### 3. Comandos de la Paleta (`Ctrl+Shift+P`)

| Comando | Descripción |
|---------|-------------|
| `Copilot Local: Listar Modelos Disponibles` | Ver modelos cargados en LM Studio |
| `Copilot Local: Cambiar Modelo Activo` | Quick pick para cambiar de modelo |
| `Copilot Local: Verificar Estado de Backends` | Estado del servidor LM Studio |
| `Copilot Local: Abrir Panel de Agentes` | Panel visual de especialistas disponibles |
| `Copilot Local: Configurar MCP` | Abrir/editar la configuración de MCP servers |

---

## Configuración

```jsonc
{
  // URL del servidor LM Studio (solo localhost por seguridad)
  "copilotLocal.lmStudioUrl": "http://localhost:1234",

  // Modelo por defecto (debe coincidir con uno cargado en LM Studio)
  "copilotLocal.defaultModel": "qwen2.5-coder-7b-instruct",

  // System prompt base enviado a todos los modelos
  "copilotLocal.systemPrompt": "Eres un asistente de programación experto en .NET, C# y desarrollo web.",

  // Tokens máximos de respuesta
  "copilotLocal.maxTokens": 4096,

  // Temperatura (0 = determinista, 1 = creativo)
  "copilotLocal.temperature": 0.7,

  // Mostrar indicador en la barra de estado
  "copilotLocal.showStatusBar": true,

  // Especialista forzado (sobrescribe la detección automática)
  // "copilotLocal.activeSpecialist": "csharp",

  // Ruta a un archivo .md de agente personalizado
  // "copilotLocal.agentFilePath": "C:/mis-agentes/mi-agente.md",

  // Auto-review de respuestas antes de mostrarlas
  "copilotLocal.selfReview": false
}
```

---

## Modelos Recomendados para LM Studio

Descarga desde la pestaña **Discover** de LM Studio:

| Modelo | Tamaño VRAM | Uso recomendado |
|--------|-------------|-----------------|
| `Qwen2.5-Coder-7B-Instruct` | ~5GB | **Código** — el mejor relación calidad/tamaño |
| `Qwen2.5-Coder-14B-Instruct` | ~9GB | Código avanzado con más contexto |
| `DeepSeek-Coder-V2-Lite-Instruct` | ~9GB | Código + razonamiento técnico |
| `Llama-3.2-3B-Instruct` | ~2GB | Ultraligero — consultas rápidas |
| `Mistral-7B-Instruct-v0.3` | ~5GB | General — razonamiento y chat |
| `Phi-3.5-mini-instruct` | ~2.5GB | Ultraligero — bueno para C# y .NET |

> **Recomendación**: `Qwen2.5-Coder-7B-Instruct` es el punto de entrada ideal para la mayoría de los casos de uso de este plugin.

---

## Arquitectura

```
VS Code Copilot Chat
       │
       ├── LanguageModelChatProvider (lmstudio-local)
       │       └── src/localModelProvider.ts
       │               └── src/lmStudioClient.ts → LM Studio API :1234/v1
       │
       └── ChatParticipant (@localai)
               └── src/chatParticipant.ts
                       ├── src/agentRouter.ts     ← detecta especialista
                       ├── src/sddWorkflow.ts     ← flujo SDD
                       ├── src/toolEngine.ts      ← herramientas del agente
                       ├── src/mcpDetector.ts     ← estado MCP
                       └── assets/agents/*.md     ← 27 definiciones de agentes
```

---

## Instalar VSIX

```bash
# 1. Clonar e instalar dependencias
git clone https://github.com/mdesantis1984/copilot-lmstudio
cd copilot-lmstudio
npm install

# 2. Compilar y empaquetar
npm run package

# 3. Instalar en VS Code
code --install-extension copilot-lmstudio-*.vsix
```

---

## Seguridad

- ✅ Solo se permiten conexiones a `localhost` (previene SSRF)
- ✅ Sin telemetría, sin datos enviados a terceros
- ✅ Todo el código y los modelos permanecen en tu máquina
- ✅ Sin API keys almacenadas ni requeridas

---

## Licencia

MIT © ThisCloud Services
