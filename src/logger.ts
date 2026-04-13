/**
 * Logger — Sistema de logging centralizado con archivo persistente.
 *
 * Escribe a:
 *   1. OutputChannel de VS Code ("Copilot + LM Studio")
 *   2. Archivo de log rotado en globalStorageUri
 *
 * Niveles: DEBUG < INFO < WARN < ERROR
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

const LEVEL_ORDER: Record<LogLevel, number> = {
    DEBUG: 0,
    INFO: 1,
    WARN: 2,
    ERROR: 3,
};

const MAX_LOG_SIZE_BYTES = 2 * 1024 * 1024; // 2 MB — rotación automática

export class Logger {
    private static _instance: Logger | undefined;

    private readonly _channel: vscode.LogOutputChannel;
    private _logFilePath: string | undefined;
    private _minLevel: LogLevel = 'INFO';

    private constructor() {
        this._channel = vscode.window.createOutputChannel('Copilot + LM Studio', { log: true }) as vscode.LogOutputChannel;
    }

    /** Singleton. Se inicializa con `Logger.init(context)`. */
    static get instance(): Logger {
        if (!Logger._instance) {
            Logger._instance = new Logger();
        }
        return Logger._instance;
    }

    /**
     * Inicializa el logger con la ruta de globalStorageUri.
     * Debe llamarse una sola vez desde `activate()`.
     */
    async init(context: vscode.ExtensionContext): Promise<void> {
        const storageDir = context.globalStorageUri.fsPath;
        try {
            await fs.promises.mkdir(storageDir, { recursive: true });
        } catch {
            // Si no se puede crear la carpeta, log solo a OutputChannel
        }
        this._logFilePath = path.join(storageDir, 'copilot-lmstudio.log');

        // Aplicar nivel de log desde configuración
        this._applyConfigLevel();

        // Rotar si el archivo supera MAX_LOG_SIZE_BYTES
        await this._rotateIfNeeded();

        context.subscriptions.push(this._channel);
        context.subscriptions.push(
            vscode.commands.registerCommand('copilotLocal.openLog', () => this.openLogFile())
        );
        // Escuchar cambios de configuración para actualizar el nivel en caliente
        context.subscriptions.push(
            vscode.workspace.onDidChangeConfiguration(e => {
                if (e.affectsConfiguration('copilotLocal.logLevel')) {
                    this._applyConfigLevel();
                }
            })
        );

        this.info('Logger', `Log file: ${this._logFilePath}`);
    }

    /** Lee copilotLocal.logLevel y actualiza _minLevel. */
    private _applyConfigLevel(): void {
        const level = vscode.workspace.getConfiguration('copilotLocal').get<LogLevel>('logLevel') ?? 'INFO';
        this._minLevel = level;
    }

    /** Abre el archivo de log en el editor. */
    async openLogFile(): Promise<void> {
        if (this._logFilePath) {
            try {
                // Asegurar que el archivo existe
                await fs.promises.access(this._logFilePath).catch(() =>
                    fs.promises.writeFile(this._logFilePath!, '', 'utf-8')
                );
                const doc = await vscode.workspace.openTextDocument(this._logFilePath);
                await vscode.window.showTextDocument(doc, { preview: false });
            } catch (err) {
                vscode.window.showWarningMessage(`No se pudo abrir el log: ${err}`);
            }
        } else {
            this._channel.show();
        }
    }

    /** Retorna la ruta del archivo de log. */
    get logFilePath(): string | undefined {
        return this._logFilePath;
    }

    // ── Métodos de logging ────────────────────────────────────────────────

    debug(scope: string, message: string, data?: Record<string, unknown>): void {
        this._log('DEBUG', scope, message, data);
    }

    info(scope: string, message: string, data?: Record<string, unknown>): void {
        this._log('INFO', scope, message, data);
    }

    warn(scope: string, message: string, data?: Record<string, unknown>): void {
        this._log('WARN', scope, message, data);
    }

    error(scope: string, message: string, data?: Record<string, unknown>): void {
        this._log('ERROR', scope, message, data);
    }

    // ── Internals ─────────────────────────────────────────────────────────

    private _log(level: LogLevel, scope: string, message: string, data?: Record<string, unknown>): void {
        if (LEVEL_ORDER[level] < LEVEL_ORDER[this._minLevel]) { return; }

        const dataStr = data ? ' ' + JSON.stringify(data) : '';
        const fileLine = `[${new Date().toISOString()}] [${level}] [${scope}] ${message}${dataStr}`;
        const channelMessage = `[${scope}] ${message}${dataStr}`;

        // OutputChannel — usa los métodos tipados de LogOutputChannel para que el panel
        // muestre el nivel correcto y no se mezcle con logs internos de VS Code.
        switch (level) {
            case 'DEBUG': this._channel.debug(channelMessage); break;
            case 'INFO':  this._channel.info(channelMessage); break;
            case 'WARN':  this._channel.warn(channelMessage); break;
            case 'ERROR': this._channel.error(channelMessage); break;
        }

        // Archivo — escritura async, no bloqueante
        if (this._logFilePath) {
            fs.promises.appendFile(this._logFilePath, fileLine + '\n', 'utf-8').catch(() => {
                // Silenciar errores de escritura
            });
        }
    }

    private async _rotateIfNeeded(): Promise<void> {
        if (!this._logFilePath) { return; }
        try {
            const stat = await fs.promises.stat(this._logFilePath);
            if (stat.size > MAX_LOG_SIZE_BYTES) {
                const rotated = this._logFilePath + '.old';
                // Eliminar old anterior si existe, luego renombrar actual
                await fs.promises.unlink(rotated).catch(() => {});
                await fs.promises.rename(this._logFilePath, rotated);
            }
        } catch {
            // Archivo no existe aún — OK
        }
    }
}
