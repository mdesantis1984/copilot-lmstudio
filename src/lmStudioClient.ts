/**
 * LmStudioClient — Cliente HTTP para LM Studio (API compatible con OpenAI)
 * Endpoint por defecto: http://localhost:1234/v1
 * LM Studio expone la API OpenAI en local sin coste ni API key real.
 */

export interface LmStudioModel {
    id: string;
    object: string;
    owned_by: string;
}

export interface LmStudioChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

interface OpenAIModelsResponse {
    data: Array<{
        id: string;
        object: string;
        owned_by: string;
    }>;
}

interface OpenAIStreamChunk {
    id: string;
    object: string;
    choices: Array<{
        delta: {
            role?: string;
            content?: string;
        };
        finish_reason: string | null;
        index: number;
    }>;
}

/**
 * Ratio conservador chars/token para estimación sin tokenizer.
 * BPE tokenizers producen ~2.0-2.5 chars/token para código/markdown.
 * Usamos 2.0 para nunca subestimar los tokens reales.
 */
export const CHARS_PER_TOKEN = 2.0;

/** Info completa de un modelo cargado, obtenida de /api/v1/models. */
export interface ModelInfo {
    key: string;
    displayName: string;
    contextLength: number;      // ctx real cargado
    maxContextLength: number;   // máximo que soporta el modelo
    flashAttention: boolean;
    numExperts: number;
    offloadKvCacheToGpu: boolean;
    evalBatchSize: number;
    trainedForToolUse: boolean;
    architecture: string | null;
    quantization: string | null;
    format: string | null;
    sizeBytes: number;
    paramsString: string | null;
    isLoaded: boolean;
}

/** Respuesta del REST endpoint /api/v1/models de LM Studio (no OpenAI-compat). */
interface LmsRestModelsResponse {
    models: Array<{
        type: string;
        key: string;
        display_name: string;
        architecture?: string | null;
        max_context_length: number;
        format?: string | null;
        size_bytes?: number;
        params_string?: string | null;
        quantization?: { name?: string | null } | null;
        capabilities?: { trained_for_tool_use?: boolean } | null;
        loaded_instances: Array<{
            id: string;
            config: {
                context_length: number;
                eval_batch_size?: number;
                flash_attention?: boolean;
                num_experts?: number;
                offload_kv_cache_to_gpu?: boolean;
            };
        }>;
    }>;
}

/**
 * Cliente para la API OpenAI-compatible de LM Studio.
 * Solo acepta URLs localhost para prevenir SSRF.
 */
export class LmStudioClient {
    private readonly baseUrl: string;    // http://localhost:1234
    private readonly apiUrl: string;     // /v1  (OpenAI-compat)
    private readonly restApiUrl: string; // /api/v1 (LM Studio REST)

    constructor(baseUrl: string) {
        this.validateBaseUrl(baseUrl);
        this.baseUrl = baseUrl.replace(/\/$/, '');
        // OpenAI-compatible endpoint
        this.apiUrl = this.baseUrl + '/v1';
        // LM Studio REST API (expone context_length real por instancia cargada)
        this.restApiUrl = this.baseUrl + '/api/v1';
    }

    /**
     * Normaliza un ID eliminando vendor prefix y sufijo de cuantización para comparación fuzzy.
     */
    private normalizeModelId(id: string): string {
        return id.split('/').pop()!
            .replace(/-[qiQI]\d[\w_]*$/i, '')
            .replace(/[-_]gguf$/i, '')
            .toLowerCase();
    }

    /**
     * Busca un modelo en la respuesta de /api/v1/models por ID (exacto o fuzzy).
     */
    private findModelInList(
        models: LmsRestModelsResponse['models'],
        modelId: string
    ): LmsRestModelsResponse['models'][number] | undefined {
        const normTarget = this.normalizeModelId(modelId);
        return (
            models.find(m => m.key === modelId) ??
            models.find(m => modelId.endsWith(m.key) || m.key.endsWith(modelId)) ??
            models.find(m => {
                const normKey = this.normalizeModelId(m.key);
                return normKey === normTarget ||
                       normKey.includes(normTarget) ||
                       normTarget.includes(normKey);
            })
        );
    }

    /**
     * Devuelve el context_length real del modelo cargado en LM Studio.
     * Consulta el endpoint REST /api/v1/models que incluye la config de cada instancia.
     * Fallback: 16 384 (seguro para modelos 7B con 32K ctx).
     */
    async getModelContextLength(modelId: string): Promise<number> {
        const info = await this.getFullModelInfo(modelId);
        return info?.contextLength ?? 16_384;
    }

    /**
     * Devuelve información completa del modelo: context real, max context,
     * flash attention, experts, etc. Null si no se puede obtener.
     */
    async getFullModelInfo(modelId: string): Promise<ModelInfo | null> {
        try {
            const response = await fetch(`${this.restApiUrl}/models`, {
                signal: AbortSignal.timeout(4000),
            });
            if (!response.ok) { return null; }

            const data = await response.json() as LmsRestModelsResponse;
            const found = this.findModelInList(data.models ?? [], modelId);
            if (!found) { return null; }

            const loaded = found.loaded_instances?.[0];
            const cfg = loaded?.config;

            return {
                key: found.key,
                displayName: found.display_name,
                contextLength: cfg?.context_length ?? found.max_context_length ?? 16_384,
                maxContextLength: found.max_context_length ?? 0,
                flashAttention: cfg?.flash_attention ?? false,
                numExperts: cfg?.num_experts ?? 0,
                offloadKvCacheToGpu: cfg?.offload_kv_cache_to_gpu ?? false,
                evalBatchSize: cfg?.eval_batch_size ?? 512,
                trainedForToolUse: found.capabilities?.trained_for_tool_use ?? false,
                architecture: found.architecture ?? null,
                quantization: found.quantization?.name ?? null,
                format: found.format ?? null,
                sizeBytes: found.size_bytes ?? 0,
                paramsString: found.params_string ?? null,
                isLoaded: (found.loaded_instances?.length ?? 0) > 0,
            };
        } catch {
            return null;
        }
    }

    /**
     * Recarga un modelo con nueva configuración (unload → load).
     * Útil para cambiar context_length en caliente.
     */
    async reloadModel(
        modelId: string,
        config: { context_length?: number; flash_attention?: boolean; num_experts?: number }
    ): Promise<{ success: boolean; loadTimeSeconds?: number; error?: string }> {
        try {
            // 1. Unload
            const unloadRes = await fetch(`${this.restApiUrl}/models/unload`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ instance_id: modelId }),
                signal: AbortSignal.timeout(30_000),
            });
            if (!unloadRes.ok) {
                const errText = await unloadRes.text().catch(() => unloadRes.statusText);
                return { success: false, error: `Unload failed: ${errText}` };
            }

            // 2. Load with new config
            const loadRes = await fetch(`${this.restApiUrl}/models/load`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: modelId,
                    ...config,
                    echo_load_config: true,
                }),
                signal: AbortSignal.timeout(120_000), // Loading puede tardar
            });
            if (!loadRes.ok) {
                const errText = await loadRes.text().catch(() => loadRes.statusText);
                return { success: false, error: `Load failed: ${errText}` };
            }

            const loadData = await loadRes.json() as { load_time_seconds?: number };
            return { success: true, loadTimeSeconds: loadData.load_time_seconds };
        } catch (err) {
            return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
    }

    /**
     * Estima los tokens de un string.
     * LM Studio NO expone /tokenize — usamos ratio conservador CHARS_PER_TOKEN (2.0).
     * Esto SOBREESTIMA tokens (seguro: nunca causa n_keep >= n_ctx).
     */
    estimateTokens(content: string): number {
        return Math.ceil(content.length / CHARS_PER_TOKEN);
    }

    /**
     * @deprecated Usa estimateTokens() — /tokenize no existe en LM Studio.
     */
    async countTokens(content: string): Promise<number> {
        return this.estimateTokens(content);
    }

    private validateBaseUrl(url: string): void {
        const parsed = new URL(url);
        if (parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
            throw new Error('Solo se permiten conexiones a localhost por seguridad.');
        }
    }

    async isAvailable(): Promise<boolean> {
        try {
            // Intentar primero el REST endpoint nativo (más informativo),
            // después el OpenAI-compat como fallback
            const r1 = fetch(`${this.restApiUrl}/models`, { signal: AbortSignal.timeout(3000) });
            const r2 = fetch(`${this.apiUrl}/models`,    { signal: AbortSignal.timeout(3000) });
            const [res1, res2] = await Promise.allSettled([r1, r2]);
            return (
                (res1.status === 'fulfilled' && res1.value.ok) ||
                (res2.status === 'fulfilled' && res2.value.ok)
            );
        } catch {
            return false;
        }
    }

    async listModels(signal?: AbortSignal): Promise<LmStudioModel[]> {
        const response = await fetch(`${this.apiUrl}/models`, {
            signal: signal ?? AbortSignal.timeout(10000),
        });
        if (!response.ok) {
            throw new Error(`Error al listar modelos de LM Studio: ${response.statusText}`);
        }
        const data = await response.json() as OpenAIModelsResponse;
        return data.data ?? [];
    }

    async *chatStream(
        model: string,
        messages: LmStudioChatMessage[],
        options: { temperature?: number; maxTokens?: number } = {},
        signal?: AbortSignal
    ): AsyncGenerator<string> {
        const body = {
            model,
            messages,
            stream: true,
            temperature: options.temperature ?? 0.7,
            max_tokens: options.maxTokens ?? 4096,
        };

        const response = await fetch(`${this.apiUrl}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer lm-studio',   // LM Studio acepta cualquier API key
            },
            body: JSON.stringify(body),
            signal,
        });

        if (!response.ok) {
            const errorText = await response.text().catch(() => response.statusText);
            throw new Error(`LM Studio chat falló (${response.status}): ${errorText}`);
        }

        if (!response.body) {
            throw new Error('La respuesta no tiene body para streaming.');
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) { break; }

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() ?? '';

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed || trimmed === 'data: [DONE]') { continue; }

                    // Formato SSE: "data: {json}"
                    const jsonStr = trimmed.startsWith('data: ')
                        ? trimmed.slice(6)
                        : trimmed;

                    try {
                        const chunk = JSON.parse(jsonStr) as OpenAIStreamChunk;
                        const content = chunk.choices?.[0]?.delta?.content;
                        if (content) {
                            yield content;
                        }
                    } catch {
                        // Ignorar líneas mal formadas
                    }
                }
            }
        } finally {
            reader.releaseLock();
        }
    }
}
