/**
 * StatsTracker — Registra estadísticas de uso del chat participant.
 * Persiste en ExtensionContext.globalState para sobrevivir recargas.
 *
 * Métricas: requests totales, tokens estimados in/out,
 * duración acumulada, errores y último modelo usado.
 */

import * as vscode from 'vscode';
import { CHARS_PER_TOKEN } from './lmStudioClient';

export interface SessionStats {
    totalRequests: number;
    totalTokensIn: number;
    totalTokensOut: number;
    totalErrors: number;
    totalDurationMs: number;
    lastRequestAt: number;   // epoch ms
    lastModel: string;
}

export interface StatRecord {
    tokensIn: number;
    tokensOut: number;
    durationMs: number;
    error: boolean;
    model: string;
}

const STORAGE_KEY = 'copilotLocal.stats.v1';

export class StatsTracker {
    private static _instance: StatsTracker | undefined;

    private stats: SessionStats;
    private readonly context: vscode.ExtensionContext;

    private constructor(context: vscode.ExtensionContext) {
        this.context = context;
        this.stats = context.globalState.get<SessionStats>(STORAGE_KEY) ?? StatsTracker.empty();
    }

    static init(context: vscode.ExtensionContext): StatsTracker {
        StatsTracker._instance = new StatsTracker(context);
        return StatsTracker._instance;
    }

    static get instance(): StatsTracker {
        if (!StatsTracker._instance) {
            throw new Error('StatsTracker.init() must be called before accessing instance');
        }
        return StatsTracker._instance;
    }

    /** Registra una request completada y persiste en globalState. */
    record(stat: StatRecord): void {
        const s = this.stats;
        s.totalRequests++;
        s.totalTokensIn  += stat.tokensIn;
        s.totalTokensOut += stat.tokensOut;
        s.totalDurationMs += stat.durationMs;
        if (stat.error) { s.totalErrors++; }
        s.lastRequestAt = Date.now();
        if (stat.model) { s.lastModel = stat.model; }
        void this.context.globalState.update(STORAGE_KEY, { ...s });
    }

    get(): SessionStats {
        return { ...this.stats };
    }

    reset(): void {
        this.stats = StatsTracker.empty();
        void this.context.globalState.update(STORAGE_KEY, { ...this.stats });
    }

    /** Estima tokens desde un array de mensajes de chat. */
    static estimateTokensIn(messages: Array<{ content: string }>): number {
        const chars = messages.reduce((sum, m) => sum + m.content.length, 0);
        return Math.ceil(chars / CHARS_PER_TOKEN);
    }

    /** Estima tokens desde los chars de la respuesta. */
    static estimateTokensOut(responseChars: number): number {
        return Math.ceil(responseChars / CHARS_PER_TOKEN);
    }

    /** Formatea tokens con sufijo K/M para mostrar en UI. */
    static formatTokens(n: number): string {
        if (n >= 1_000_000) { return `${(n / 1_000_000).toFixed(1)}M`; }
        if (n >= 1_000)     { return `${(n / 1_000).toFixed(1)}K`; }
        return String(n);
    }

    /** Formatea duración media en segundos. */
    static formatAvgDuration(totalMs: number, count: number): string {
        if (count === 0) { return '—'; }
        return `${(totalMs / count / 1000).toFixed(1)}s`;
    }

    /** Formatea timestamp relativo (hace Xm / hace Xh). */
    static formatRelativeTime(ts: number): string {
        if (!ts) { return '—'; }
        const diffMs = Date.now() - ts;
        const mins = Math.floor(diffMs / 60_000);
        if (mins < 1)   { return 'ahora'; }
        if (mins < 60)  { return `hace ${mins}m`; }
        const hours = Math.floor(mins / 60);
        if (hours < 24) { return `hace ${hours}h`; }
        return `hace ${Math.floor(hours / 24)}d`;
    }

    private static empty(): SessionStats {
        return {
            totalRequests: 0,
            totalTokensIn: 0,
            totalTokensOut: 0,
            totalErrors: 0,
            totalDurationMs: 0,
            lastRequestAt: 0,
            lastModel: '',
        };
    }
}
