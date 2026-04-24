# Copilot Local Models — Zero Cost AI

[![VS Code](https://img.shields.io/badge/VS%20Code-1.95%2B-blue?logo=visualstudiocode)](https://code.visualstudio.com/)
[![Version](https://img.shields.io/badge/version-1.1.60-blueviolet)](https://github.com/mdesantis1984/copilot-lmstudio)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![.NET](https://img.shields.io/badge/.NET-10%20LTS-purple?logo=dotnet)](https://dotnet.microsoft.com/)

Potencia GitHub Copilot con modelos de IA locales de coste cero usando LM Studio como motor principal. Conecta cualquier modelo GGUF a VS Code — sin API keys, sin facturación y sin enviar código fuera de tu máquina.

---

## Resumen

- Modelos locales disponibles en el selector de Copilot.
- Chat participant `@localai` para interacción y comandos.
- Streaming de respuestas, panel lateral con estado y estadísticas.
- 27 agentes especialistas para .NET, web, infra, testing y más.
- 3 LM Tools registradas: `localai_startSdd`, `localai_setSpecialist`, `localai_getStatus`.

---

## Características principales

| Característica | Descripción |
|---|---|
| Modelos en el picker | Los modelos cargados en LM Studio aparecen junto a los modelos cloud en Copilot |
| `@localai` en Chat | Activa el participante local con agentes especialistas |
| Streaming | Respuestas en tiempo real, igual que en la nube |
| Privacidad | Todo local: el código no sale de tu equipo |
| Coste cero | Sin keys ni facturación externa |
| Panel y stats | Panel lateral con estado de LM Studio y métricas de uso |

---

## Agentes especialistas

Incluye 27 agentes (lista completa en `assets/agents/`). Ejemplos: `csharp`, `blazor-server`, `microservices`, `frontend`, `typescript`, `sdd`, `unit-testing`, `web-security`, `playwright`, `pytest`, `ai-sdk`, `github-pr`, `interface-programming`.

---

## Requisitos

1. Instalar LM Studio (https://lmstudio.ai).
2. Descargar al menos un modelo y activar el servidor Developer (puerto `1234`).
3. Verificar `http://localhost:1234/v1/models` responde.

---

## Uso rápido

- Chat: escribe `@localai` seguido de tu pregunta o comando.
- Comandos útiles:

```
@localai /models        # Lista modelos
@localai /switch <mod>  # Cambia modelo activo
@localai /status        # Estado de LM Studio
@localai /sdd           # Inicia flujo SDD
@localai /agent <id>    # Fuerza un especialista
```

- Paleta (Ctrl+Shift+P):
	- `Copilot Local: Listar Modelos Disponibles`
	- `Copilot Local: Cambiar Modelo Activo`
	- `Copilot Local: Verificar Estado de Backends`
	- `Copilot Local: Abrir Panel de Agentes`
	- `Copilot Local: Configurar MCP`

---

## Configuración (ejemplo)

```jsonc
{
	"copilotLocal.lmStudioUrl": "http://localhost:1234",
	"copilotLocal.defaultModel": "qwen2.5-coder-7b-instruct",
	"copilotLocal.systemPrompt": "Eres un asistente de programación experto en .NET, C# y desarrollo web.",
	"copilotLocal.maxTokens": 4096,
	"copilotLocal.temperature": 0.7,
	"copilotLocal.showStatusBar": true,
	"copilotLocal.maxInjectedTools": 60,
	"copilotLocal.selfReview": false
}
```

---

## Modelos recomendados

| Modelo | VRAM aprox. | Uso |
|---|---:|---|
| Qwen2.5-Coder-7B-Instruct | ~5GB | Código: buena relación calidad/tamaño |
| Qwen2.5-Coder-14B-Instruct | ~9GB | Código avanzado |
| DeepSeek-Coder-V2-Lite | ~9GB | Código + razonamiento técnico |
| Mistral-7B-Instruct-v0.3 | ~5GB | General, chat y razonamiento |

---

## Arquitectura (resumen)

```
VS Code Copilot Chat
	├─ LanguageModelChatProvider (lmstudio-local)
	│   └─ src/localModelProvider.ts -> src/lmStudioClient.ts --> LM Studio :1234/v1
	├─ ChatParticipant (@localai)
	│   └─ src/agentRouter.ts, src/sddWorkflow.ts, src/toolEngine.ts, src/mcpDetector.ts
	└─ Sidebar (AgentPanelProvider) + LM Tools (src/extension.ts)
```

---

## Instalación del VSIX

```bash
git clone https://github.com/mdesantis1984/copilot-lmstudio
cd copilot-lmstudio
npm install
npm run package
code --install-extension copilot-lmstudio-*.vsix
```

---

## Changelog

### 1.1.60 — 2026-04-24
- Versión incrementada a `1.1.60`.
- Limpieza del `README.md`: unificada la sección `Changelog` y eliminadas entradas duplicadas.

### 1.1.59 — 2026-04-24
- Nueva configuración: `copilotLocal.maxInjectedTools` (número, default: 60) para limitar herramientas inyectadas en el system prompt.
- Correcciones y aprendizajes: hallazgos registrados en el sistema de recuerdos (IA_recuerdos) para trazabilidad.
- Archivos modificados: `src/toolEngine.ts`, `src/chatParticipant.ts`, `src/agentPanel.ts`, `package.json`, `README.md`.
- Empaquetado: `copilot-lmstudio-1.1.59.vsix` disponible en el root del repo.

### 1.1.56 — 2026-04-24
- Cambios de comportamiento: detección automática por defecto del especialista; la clave global `copilotLocal.activeSpecialist` se ignora salvo override a nivel Workspace/Folder.
- `Agent Panel`: selección de especialista guardada a nivel Workspace (override local).
- Mejoras de diagnóstico: logs adicionales que registran la decisión de ruteo y contexto del workspace (routing decision, workspaceFolders, activeFile).
- Robustez: handlers locales para operaciones de archivos y mejoras en invocación de herramientas.
- Empaquetado: `copilot-lmstudio-1.1.56.vsix`.

### 1.1.55 — 2026-04-24
- Implementa "Opción A": handlers locales para operaciones de archivos (`copilot_findFiles`, `copilot_readFile`, `copilot_listDirectory`, `copilot_readProjectStructure`) en `src/toolEngine.ts`.
- Validación y decodificación segura de `LanguageModelToolResult.content` para mayor robustez.
- Empaquetado: `copilot-lmstudio-1.1.55.vsix`.

### 1.1.53 — 2026-04-15
- UI/UX: eliminado el TreeView separado "SDD Workflow"; el stepper SDD está integrado en la card del webview "Agente & Skills".
- SDD card: botones `▶ Iniciar` / `⏹ Cancelar` movidos al header; padding ajustado en `.sdd-stepper`.

### 1.1.52 — 2026-04-15
- `StatsTracker`: nuevo módulo de tracking persistente (tokens in/out, requests, errores, duración media, tasa de éxito) — sobrevive recargas vía `globalState`.
- Sidebar: `agentPanel` rediseñado con avatar SVG animado, stepper SDD de 9 dots, config en grid 2×3, stats en grid 3×2.
- Fix race condition: `_cachedStatus` en `AgentPanelProvider` evita que `_refreshPanel()` resetee el chip de estado antes de recibir el resultado async.
- LM Tools: 3 herramientas registradas en Copilot Agent Mode (`localai_startSdd`, `localai_setSpecialist`, `localai_getStatus`).
- SDD Panel mejorado: iconos actualizados (`play-circle`, `pass-filled`), labels sin prefijo numérico y descripción compacta por paso.
- `lmStudioClient`: `ModelInfo` interface, `getFullModelInfo()`, `reloadModel()`, `estimateTokens()`, `CHARS_PER_TOKEN=2.0` (fix `n_keep >= n_ctx`).
- `modelManager`: timeout de 4s en status check para no bloquear el panel.
- `mcpDetector`: detección de `ia-orquestador` + `ia-recuerdo`, `saveDroppedHistoryToMemory()` para persistir historial recortado.
- MCP commands: `copilotLocal.openMcpConfig` y `copilotLocal.checkMcpStatus` en la paleta.

### 1.1.46
- Commit inicial público — integración base LM Studio + Copilot Chat.

---

## Seguridad

- Solo conexiones a `localhost`.
- Sin telemetría ni envío de datos a terceros.

---

## Licencia

MIT © ThisCloud Services

| `Copilot Local: Verificar Estado de Backends` | Estado del servidor LM Studio |
