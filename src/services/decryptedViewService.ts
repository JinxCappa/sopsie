import * as vscode from 'vscode';
import * as path from 'path';
import { SopsRunner } from '../sops/sopsRunner';
import { TempFileHandler } from '../handlers/tempFileHandler';
import { DecryptedContentProvider } from '../providers/decryptedContentProvider';
import { SettingsService } from './settingsService';
import { EditorGroupTracker } from './editorGroupTracker';
import { logger } from './loggerService';

export interface ShowDecryptedOptions {
    /** Whether to preserve focus on the original editor (true for auto, false for manual) */
    preserveFocus: boolean;
    /** Show info message on success (for edit-in-place mode). Defaults to true. */
    showInfoMessage?: boolean;
    /** Explicit view column to use instead of calculating from settings */
    targetColumn?: vscode.ViewColumn;
}

/**
 * Service for opening decrypted views of SOPS files.
 * Handles both read-only preview and editable temp file modes.
 */
export class DecryptedViewService implements vscode.Disposable {
    constructor(
        private sopsRunner: SopsRunner,
        private tempFileHandler: TempFileHandler,
        private settingsService: SettingsService,
        private editorGroupTracker: EditorGroupTracker
    ) {}

    /**
     * Set document language with fallback to plaintext
     */
    private async setDocumentLanguage(doc: vscode.TextDocument, filePath: string): Promise<void> {
        const languageId = DecryptedContentProvider.getLanguageId(filePath);
        try {
            await vscode.languages.setTextDocumentLanguage(doc, languageId);
        } catch {
            // Language ID may not be available (e.g., 'dotenv' requires an extension)
            if (languageId !== 'plaintext') {
                await vscode.languages.setTextDocumentLanguage(doc, 'plaintext');
            }
        }
    }

    /**
     * Track document after opening, handling stale editor references
     */
    private trackOpenedDocument(
        doc: vscode.TextDocument,
        sourceUri: vscode.Uri,
        shownEditor: vscode.TextEditor,
        viewColumn: vscode.ViewColumn
    ): vscode.ViewColumn {
        // Re-fetch the editor after setTextDocumentLanguage (original shownEditor may be stale)
        const currentEditor = vscode.window.visibleTextEditors.find(
            e => e.document.uri.toString() === doc.uri.toString()
        ) ?? shownEditor;

        const effectiveViewColumn = currentEditor.viewColumn ?? viewColumn;
        this.editorGroupTracker.trackDocumentOpened(doc.uri, sourceUri, effectiveViewColumn);
        return effectiveViewColumn;
    }

    /**
     * Open a decrypted view based on current settings.
     * Routes to either preview or edit-in-place based on decryptedViewMode setting.
     */
    async openDecryptedView(
        sourceUri: vscode.Uri,
        options: ShowDecryptedOptions
    ): Promise<void> {
        if (this.settingsService.getDecryptedViewMode() === 'editInPlace') {
            await this.openEditInPlace(sourceUri, options);
        } else {
            await this.openPreview(sourceUri, options);
        }
    }

    /**
     * Open a read-only preview of the decrypted content.
     * Uses a virtual document provider to display decrypted content without modifying the file.
     */
    async openPreview(
        sourceUri: vscode.Uri,
        options: ShowDecryptedOptions
    ): Promise<void> {
        const previewUri = DecryptedContentProvider.createPreviewUri(sourceUri);

        // Set guard flag to prevent auto-close/focus-return during the entire operation
        this.editorGroupTracker.setExtensionTriggeredOpen(true);
        try {
            const doc = await vscode.workspace.openTextDocument(previewUri);
            const viewColumn = options.targetColumn
                ?? (this.settingsService.shouldOpenDecryptedBeside()
                    ? vscode.ViewColumn.Beside
                    : vscode.ViewColumn.Active);
            const shownEditor = await vscode.window.showTextDocument(doc, {
                viewColumn,
                preview: false,
                preserveFocus: options.preserveFocus
            });

            await this.setDocumentLanguage(doc, sourceUri.fsPath);
            this.trackOpenedDocument(doc, sourceUri, shownEditor, viewColumn);
        } finally {
            this.editorGroupTracker.setExtensionTriggeredOpen(false);
        }
    }

    /**
     * Open an editable temp file with decrypted content.
     * Creates a temporary file that automatically encrypts back to the original on save.
     */
    async openEditInPlace(
        sourceUri: vscode.Uri,
        options: ShowDecryptedOptions
    ): Promise<void> {
        const decrypted = await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Decrypting file...',
                cancellable: false
            },
            async () => {
                return await this.sopsRunner.decrypt(sourceUri.fsPath);
            }
        );

        const tempUri = await this.tempFileHandler.createTempFile(sourceUri, decrypted);

        // Set guard flag to prevent auto-close/focus-return during the entire operation
        this.editorGroupTracker.setExtensionTriggeredOpen(true);
        try {
            const doc = await vscode.workspace.openTextDocument(tempUri);
            const viewColumn = options.targetColumn
                ?? (this.settingsService.shouldOpenDecryptedBeside()
                    ? vscode.ViewColumn.Beside
                    : vscode.ViewColumn.Active);
            const shownEditor = await vscode.window.showTextDocument(doc, {
                viewColumn,
                preview: false,
                preserveFocus: options.preserveFocus
            });

            await this.setDocumentLanguage(doc, sourceUri.fsPath);
            this.trackOpenedDocument(doc, sourceUri, shownEditor, viewColumn);
        } finally {
            this.editorGroupTracker.setExtensionTriggeredOpen(false);
        }

        if (options.showInfoMessage !== false) {
            vscode.window.showInformationMessage(
                `Editing decrypted copy. Save to encrypt back to ${path.basename(sourceUri.fsPath)}`
            );
        }
    }

    /**
     * Switch the current preview/edit-in-place to show a different file.
     * Handles unsaved changes in edit-in-place mode with a prompt.
     */
    async switchToFile(newSourceUri: vscode.Uri): Promise<void> {
        logger.debug('[DecryptedViewService] switchToFile called for:', newSourceUri.path.split('/').pop());
        const currentMode = this.getCurrentMode();
        logger.debug('[DecryptedViewService] switchToFile: currentMode=', currentMode);
        if (!currentMode) {
            logger.debug('[DecryptedViewService] switchToFile: No current mode, opening fresh view');
            await this.openDecryptedView(newSourceUri, { preserveFocus: true });
            return;
        }

        if (currentMode === 'editInPlace') {
            const tempDoc = this.getCurrentTempDocument();
            if (tempDoc?.isDirty) {
                const choice = await vscode.window.showWarningMessage(
                    'You have unsaved changes in the decrypted file. Save before switching?',
                    'Save',
                    'Discard',
                    'Cancel'
                );
                if (choice === 'Cancel' || choice === undefined) {
                    return;
                }
                if (choice === 'Save') {
                    await tempDoc.save();
                }
            }
        }

        // Capture the current preview's column and original file URI BEFORE closing
        const tracked = this.editorGroupTracker.getCurrentTrackedDocument();
        const previewColumn = tracked?.openedInColumn;
        const originalColumn = tracked?.originalColumn ?? vscode.ViewColumn.One;
        const oldSourceUri = tracked?.originalActiveUri ? vscode.Uri.parse(tracked.originalActiveUri) : undefined;
        logger.debug('[DecryptedViewService] switchToFile: previewColumn=', previewColumn, 'originalColumn=', originalColumn, 'oldSourceUri=', oldSourceUri?.path.split('/').pop());

        await this.editorGroupTracker.closeAllTrackedDocuments({ skipFocusReturn: true });

        // Close the old encrypted file if autoClosePairedTab is enabled
        if (oldSourceUri && this.settingsService.shouldAutoClosePairedTab()) {
            const oldFileTab = this.findTabByUri(oldSourceUri);
            if (oldFileTab) {
                logger.debug('[DecryptedViewService] switchToFile: Closing old encrypted file:', oldSourceUri.path.split('/').pop());
                await vscode.window.tabGroups.close(oldFileTab.tab);
            }
        }

        // If openDecryptedBeside is enabled and we know which column the preview was in,
        // ensure the encrypted file is in column 1 and reuse the preview column
        if (this.settingsService.shouldOpenDecryptedBeside() && previewColumn !== undefined) {
            // Check if the new encrypted file opened in the wrong column (the preview column)
            const newFileTab = this.findTabByUri(newSourceUri);
            logger.debug('[DecryptedViewService] switchToFile: newFileTab found=', !!newFileTab, 'newFileColumn=', newFileTab?.group.viewColumn);
            if (newFileTab && newFileTab.group.viewColumn === previewColumn) {
                logger.debug('[DecryptedViewService] switchToFile: Relocating encrypted file from column', previewColumn, 'to column', originalColumn);
                // Move the encrypted file to column 1
                await vscode.window.tabGroups.close(newFileTab.tab);
                const doc = await vscode.workspace.openTextDocument(newSourceUri);
                await vscode.window.showTextDocument(doc, {
                    viewColumn: originalColumn,
                    preview: false,
                    preserveFocus: false
                });
            }

            // Open preview in the explicit column (not Beside)
            logger.debug('[DecryptedViewService] switchToFile: Opening preview in explicit column', previewColumn);
            await this.openDecryptedView(newSourceUri, {
                preserveFocus: true,
                showInfoMessage: false,
                targetColumn: previewColumn
            });
        } else {
            // Non-beside mode or no previous column info - use default behavior
            logger.debug('[DecryptedViewService] switchToFile: Using default behavior (beside or no previewColumn)');
            await this.openDecryptedView(newSourceUri, { preserveFocus: true, showInfoMessage: false });
        }

        // Ensure focus returns to the source file after opening
        try {
            const sourceDoc = vscode.workspace.textDocuments.find(
                d => d.uri.toString() === newSourceUri.toString()
            );
            if (sourceDoc) {
                await vscode.window.showTextDocument(sourceDoc, {
                    viewColumn: originalColumn,
                    preserveFocus: false,
                    preview: false
                });
            }
        } catch {
            // Ignore focus errors
        }
    }

    /**
     * Get the current mode based on tracked document type.
     */
    private getCurrentMode(): 'preview' | 'editInPlace' | null {
        const tracked = this.editorGroupTracker.getCurrentTrackedDocument();
        logger.debug('[DecryptedViewService] getCurrentMode: tracked=', !!tracked, 'docUri=', tracked?.docUri);
        if (!tracked) {
            return null;
        }

        if (tracked.docUri.startsWith('sops-decrypted:')) {
            return 'preview';
        }
        if (tracked.docUri.includes('.sops-edit')) {
            return 'editInPlace';
        }
        return null;
    }

    /**
     * Get the TextDocument for the current temp file (if in edit-in-place mode).
     */
    private getCurrentTempDocument(): vscode.TextDocument | undefined {
        const tracked = this.editorGroupTracker.getCurrentTrackedDocument();
        if (!tracked) {
            return undefined;
        }

        return vscode.workspace.textDocuments.find(
            (doc) => doc.uri.toString() === tracked.docUri
        );
    }

    /**
     * Find a tab by its URI across all tab groups.
     */
    private findTabByUri(uri: vscode.Uri): { tab: vscode.Tab; group: vscode.TabGroup } | undefined {
        for (const tabGroup of vscode.window.tabGroups.all) {
            for (const tab of tabGroup.tabs) {
                if (tab.input instanceof vscode.TabInputText) {
                    if (tab.input.uri.toString() === uri.toString()) {
                        return { tab, group: tabGroup };
                    }
                }
            }
        }
        return undefined;
    }

    dispose(): void {
        // Currently no disposables needed - service is stateless
    }
}
