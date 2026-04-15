/**
 * sddPanel.ts — TreeView en la sidebar para mostrar el estado del flujo SDD.
 *
 * Muestra los 9 pasos con iconos de estado:
 *   ✅ completado | ▶ activo | ⏳ pendiente
 */

import * as vscode from 'vscode';
import {
    SddStep,
    SddState,
    STEP_NAMES,
    getSddState,
    onStateChange,
} from './sddWorkflow';

const STEP_SEQUENCE: SddStep[] = [
    'init', 'explore', 'design', 'spec',
    'propose', 'tasks', 'apply', 'verify', 'archive',
];

export class SddPanelProvider implements vscode.TreeDataProvider<SddStepItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<SddStepItem | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private _disposables: vscode.Disposable[] = [];

    constructor() {
        this._disposables.push(
            onStateChange(() => this._refresh())
        );
    }

    private _refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: SddStepItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: SddStepItem): SddStepItem[] {
        if (element) {
            // Sub-items: tareas del paso Apply
            if (element.step === 'apply') {
                return this._getTaskItems();
            }
            return [];
        }

        return this._getStepItems();
    }

    private _getStepItems(): SddStepItem[] {
        const state = getSddState();
        return STEP_SEQUENCE.map(step => new SddStepItem(step, state));
    }

    private _getTaskItems(): SddStepItem[] {
        const state = getSddState();
        return state.taskList.map((task, i) => {
            const item = new SddStepItem('apply', state, `TASK-${String(i + 1).padStart(2, '0')}: ${task.description}`);
            item.taskId = task.id;
            item.checkboxState = task.completed
                ? vscode.TreeItemCheckboxState.Checked
                : vscode.TreeItemCheckboxState.Unchecked;
            return item;
        });
    }

    dispose(): void {
        for (const d of this._disposables) {
            d.dispose();
        }
        this._onDidChangeTreeData.dispose();
    }
}

export class SddStepItem extends vscode.TreeItem {
    public readonly step: SddStep;
    /** ID de tarea SDD (solo para sub-items del paso Apply). */
    public taskId?: string;

    constructor(
        step: SddStep,
        state: SddState,
        overrideLabel?: string
    ) {
        const isActive = state.step === step;
        const isPast = isPastStep(step, state.step);
        const isIdle = state.step === 'idle' || state.step === 'completed';

        // Label limpio: quitar el prefijo "N. " que viene de STEP_NAMES
        const rawLabel = overrideLabel ?? STEP_NAMES[step];
        const label = rawLabel.replace(/^\d+\.\s*/, '');
        const stepNum = STEP_SEQUENCE.indexOf(step) + 1;

        super(label, step === 'apply' && state.taskList.length > 0
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.None);

        this.step = step;
        this.tooltip = getStepTooltip(step, state);

        this.contextValue = isActive ? 'sdd-step-active' : isPast ? 'sdd-step-done' : 'sdd-step-pending';

        if (isActive && !isIdle) {
            this.description = `← ${stepNum}/9`;
            this.iconPath = new vscode.ThemeIcon('play-circle', new vscode.ThemeColor('charts.blue'));
        } else if (isPast) {
            this.description = `✓`;
            this.iconPath = new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('charts.green'));
        } else if (!isIdle) {
            this.description = `${stepNum}/9`;
            this.iconPath = new vscode.ThemeIcon('circle-large-outline', new vscode.ThemeColor('disabledForeground'));
        } else {
            this.description = `${stepNum}`;
            this.iconPath = new vscode.ThemeIcon('circle-large-outline');
        }
    }
}

function isPastStep(step: SddStep, currentStep: SddStep): boolean {
    if (currentStep === 'idle') { return false; }
    if (currentStep === 'completed') { return true; }
    const currentIdx = STEP_SEQUENCE.indexOf(currentStep);
    const stepIdx = STEP_SEQUENCE.indexOf(step);
    return stepIdx < currentIdx;
}

function getStepTooltip(step: SddStep, state: SddState): string {
    const contextEntry = state.context[step];
    if (contextEntry) {
        return `${STEP_NAMES[step]}\n\n${contextEntry.slice(0, 200)}${contextEntry.length > 200 ? '...' : ''}`;
    }
    return STEP_NAMES[step];
}
