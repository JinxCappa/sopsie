import * as vscode from 'vscode';
import { SettingsService } from './settingsService';
import { logger } from './loggerService';

interface TrackedDocument {
    docUri: string;
    openedInColumn: vscode.ViewColumn;
    originalActiveUri: string | undefined;
    originalColumn: vscode.ViewColumn | undefined;
    wasOpenedBeside: boolean;
}

/**
 * Tracks editor groups for SOPSie-opened documents.
 * Handles auto-closing of tracked documents when user opens another file.
 * When extension documents close, returns focus to the original editor
 * so VS Code can naturally collapse empty editor groups.
 */
export class EditorGroupTracker implements vscode.Disposable {
    private trackedDocs = new Map<string, TrackedDocument>();
    private disposables: vscode.Disposable[] = [];
    private extensionOpenCount = 0;
    private recentlyClosedPreviewSource: string | null = null;

    constructor(private settingsService: SettingsService) {
        // Listen for document opens to detect when user opens another file
        this.disposables.push(
            vscode.workspace.onDidOpenTextDocument((doc) => {
                this.handleExternalDocumentOpened(doc);
            })
        );

        // Listen for tab closes (reliable, unlike onDidCloseTextDocument which only fires on document disposal)
        this.disposables.push(
            vscode.window.tabGroups.onDidChangeTabs((event) => {
                this.handleTabsChanged(event);
            })
        );
    }

    /**
     * Set flag to indicate extension is about to open a document.
     * Uses a counter to handle concurrent opens safely.
     * Prevents auto-close from triggering during extension operations.
     */
    setExtensionTriggeredOpen(value: boolean): void {
        this.extensionOpenCount += value ? 1 : -1;
        this.extensionOpenCount = Math.max(0, this.extensionOpenCount);
    }

    /**
     * Track document opened by extension, linking decrypted to source file.
     * @param decryptedUri URI of the decrypted/preview document
     * @param sourceUri URI of the source encrypted file
     * @param openedInColumn Column where the decrypted document was opened
     */
    trackDocumentOpened(decryptedUri: vscode.Uri, sourceUri: vscode.Uri, openedInColumn: vscode.ViewColumn): void {
        const activeEditor = vscode.window.activeTextEditor;
        const originalColumn = activeEditor?.viewColumn;

        const key = decryptedUri.toString();
        this.trackedDocs.set(key, {
            docUri: key,
            openedInColumn,
            originalActiveUri: sourceUri.toString(),
            originalColumn,
            wasOpenedBeside: originalColumn !== undefined && openedInColumn !== originalColumn
        });
    }

    /**
     * Check if a URI is tracked by this service
     */
    isTracked(uri: vscode.Uri): boolean {
        return this.trackedDocs.has(uri.toString());
    }

    /**
     * Get the currently tracked document (if any preview/edit-in-place is open).
     * Returns the first tracked document, typically there's only one at a time.
     */
    getCurrentTrackedDocument(): TrackedDocument | undefined {
        for (const [, tracked] of this.trackedDocs) {
            return tracked;
        }
        return undefined;
    }

    /**
     * Check if extension is currently in the middle of opening a document
     */
    isExtensionOpening(): boolean {
        return this.extensionOpenCount > 0;
    }

    /**
     * Check if we recently closed a preview for the given source file.
     * Used to prevent re-opening a preview when focus returns to the original file.
     * @param sourceUri The source file URI to check
     */
    isClosingPairedFor(sourceUri: vscode.Uri): boolean {
        const result = this.recentlyClosedPreviewSource === sourceUri.toString();
        logger.debug('[EditorGroupTracker] isClosingPairedFor(', sourceUri.path.split('/').pop(), ') =', result);
        return result;
    }

    /**
     * Handle external document opened - auto-close tracked docs if enabled.
     * Note: When openBehavior='showDecrypted', DocumentWatcher.maybeUpdateDecryptedView
     * handles all auto-close logic to avoid race conditions.
     */
    private async handleExternalDocumentOpened(doc: vscode.TextDocument): Promise<void> {
        // Skip if auto-close is disabled
        if (!this.settingsService.shouldAutoCloseTab()) {
            return;
        }

        // Skip if openBehavior is showDecrypted - DocumentWatcher.maybeUpdateDecryptedView
        // handles all preview management in this mode to avoid race conditions
        if (this.settingsService.getOpenBehavior() === 'showDecrypted') {
            return;
        }

        // Skip if this open was triggered by our extension
        if (this.extensionOpenCount > 0) {
            return;
        }

        // Only react to regular file opens
        if (doc.uri.scheme !== 'file') {
            return;
        }

        // Don't close if we have no tracked documents
        if (this.trackedDocs.size === 0) {
            return;
        }

        // Check if any tracked document was opened "beside" (in a different column)
        const hasDocOpenedBeside = Array.from(this.trackedDocs.values())
            .some(t => t.wasOpenedBeside);

        if (hasDocOpenedBeside) {
            // Intercept and relocate: the new file likely opened in the SOPS column
            await this.interceptAndRelocate(doc.uri);
        } else {
            // Same-column mode - just close the preview tabs without focus manipulation
            // Let the user's new file stay focused
            await this.closeTrackedTabsOnly();
        }
    }

    /**
     * Close tracked preview/edit tabs without manipulating focus.
     * Used when openDecryptedBeside=false to avoid interfering with user's new file.
     */
    private async closeTrackedTabsOnly(): Promise<void> {
        if (this.trackedDocs.size === 0) {
            return;
        }

        for (const [, doc] of this.trackedDocs) {
            const uri = vscode.Uri.parse(doc.docUri);
            await this.closeTab(uri);
        }

        this.trackedDocs.clear();
    }

    /**
     * Handle tab changes - detect when tracked tabs or original files are closed.
     * This is more reliable than onDidCloseTextDocument which only fires on document disposal.
     */
    private async handleTabsChanged(event: vscode.TabChangeEvent): Promise<void> {
        for (const closedTab of event.closed) {
            if (!(closedTab.input instanceof vscode.TabInputText)) {
                continue;
            }

            const closedUriStr = closedTab.input.uri.toString();
            logger.debug('[EditorGroupTracker] handleTabsChanged - tab closed:', closedUriStr);

            // Case 1: A tracked decrypted/temp file was closed
            const tracked = this.trackedDocs.get(closedUriStr);
            logger.debug('[EditorGroupTracker] handleTabsChanged - tracked found:', !!tracked, 'trackedDocs.size:', this.trackedDocs.size);
            if (tracked) {
                this.trackedDocs.delete(closedUriStr);

                // Store which source file's preview was closed to prevent re-opening
                // Only blocks re-opening for THIS specific file, not other files
                const sourceUri = tracked.originalActiveUri ?? null;
                logger.debug('[EditorGroupTracker] handleTabsChanged - Setting recentlyClosedPreviewSource =', sourceUri);
                this.recentlyClosedPreviewSource = sourceUri;
                try {
                    // Close the paired original file (if setting enabled)
                    if (this.settingsService.shouldAutoClosePairedTab() && tracked.originalActiveUri) {
                        const originalUri = vscode.Uri.parse(tracked.originalActiveUri);
                        await this.closeTab(originalUri);
                    } else if (this.settingsService.shouldAutoCloseTab()) {
                        // Return focus to original editor (when autoClosePairedTab is disabled)
                        await this.returnFocusToOriginal(tracked);
                    }
                } finally {
                    // In same-column mode, delay clearing to let focus events settle
                    // In beside mode, clear immediately - separate columns provide isolation
                    if (tracked.wasOpenedBeside) {
                        this.recentlyClosedPreviewSource = null;
                    } else {
                        setTimeout(() => {
                            this.recentlyClosedPreviewSource = null;
                        }, 100);
                    }
                }
                continue;
            }

            // Case 2: An original encrypted file was closed
            const associatedDocs = Array.from(this.trackedDocs.entries())
                .filter(([, t]) => t.originalActiveUri === closedUriStr);

            if (associatedDocs.length > 0 && this.settingsService.shouldAutoClosePairedTab()) {
                // Store which source file was closed
                this.recentlyClosedPreviewSource = closedUriStr;
                try {
                    for (const [docUri] of associatedDocs) {
                        await this.closeTab(vscode.Uri.parse(docUri));
                        this.trackedDocs.delete(docUri);
                    }
                } finally {
                    // Check if any of the closed docs were opened beside
                    const anyOpenedBeside = associatedDocs.some(([, t]) => t.wasOpenedBeside);
                    if (anyOpenedBeside) {
                        this.recentlyClosedPreviewSource = null;
                    } else {
                        setTimeout(() => {
                            this.recentlyClosedPreviewSource = null;
                        }, 100);
                    }
                }
            }
            // If autoClosePairedTab disabled, keep preview tracked for autoCloseTab
        }
    }

    /**
     * Close all tracked documents and optionally return focus to original.
     * Called programmatically (e.g., from maybeUpdateDecryptedView) - NOT from user tab close.
     * We clear trackedDocs BEFORE closing tabs so handleTabsChanged doesn't
     * react and set recentlyClosedPreviewSource (which would block subsequent operations).
     * @param options.skipFocusReturn - If true, don't return focus to original (caller manages focus)
     */
    async closeAllTrackedDocuments(options?: { skipFocusReturn?: boolean }): Promise<void> {
        logger.debug('[EditorGroupTracker] closeAllTrackedDocuments() called, trackedDocs.size =', this.trackedDocs.size);
        if (this.trackedDocs.size === 0) {
            return;
        }

        const tracked = Array.from(this.trackedDocs.values());
        const firstTracked = tracked[0];

        // Clear BEFORE closing so handleTabsChanged doesn't find them
        // and doesn't set isClosingPairedTabs or do duplicate cleanup
        logger.debug('[EditorGroupTracker] Clearing trackedDocs before closing tabs');
        this.trackedDocs.clear();

        for (const doc of tracked) {
            const uri = vscode.Uri.parse(doc.docUri);
            logger.debug('[EditorGroupTracker] Closing tab:', uri.toString());
            await this.closeTab(uri);
        }

        if (firstTracked && !options?.skipFocusReturn) {
            logger.debug('[EditorGroupTracker] Returning focus to original:', firstTracked.originalActiveUri);
            await this.returnFocusToOriginal(firstTracked);
        }
        logger.debug('[EditorGroupTracker] closeAllTrackedDocuments() done');
    }

    /**
     * Programmatically close a specific tab using VS Code's tabGroups API
     */
    private async closeTab(uri: vscode.Uri): Promise<void> {
        const targetUri = uri.toString();
        try {
            for (const tabGroup of vscode.window.tabGroups.all) {
                for (const tab of tabGroup.tabs) {
                    if (tab.input instanceof vscode.TabInputText) {
                        if (tab.input.uri.toString() === targetUri) {
                            await vscode.window.tabGroups.close(tab);
                            return;
                        }
                    }
                }
            }
        } catch {
            // Tab may already be closed
        }
    }

    /**
     * Return focus to the original editor that was active before opening
     */
    private async returnFocusToOriginal(tracked: TrackedDocument): Promise<void> {
        if (!tracked.originalActiveUri || tracked.originalColumn === undefined) {
            return;
        }

        try {
            const targetEditor = vscode.window.visibleTextEditors.find(
                e => e.document.uri.toString() === tracked.originalActiveUri
            );

            if (targetEditor) {
                await vscode.window.showTextDocument(targetEditor.document, {
                    viewColumn: tracked.originalColumn,
                    preserveFocus: false,
                    preview: false
                });
            }
        } catch {
            // Original document may be closed - ignore
        }
    }

    /**
     * Intercept a file that opened in the wrong column and relocate it.
     * Used when user clicks a file while SOPS tab is focused in a "beside" column.
     * Only relocates if the file opened in the SOPS column - if it opened in the
     * original column (because that column was in focus), no relocation is needed.
     */
    private async interceptAndRelocate(externalUri: vscode.Uri): Promise<void> {
        const tracked = Array.from(this.trackedDocs.values());
        const sopsColumn = tracked[0]?.openedInColumn;
        const originalColumn = tracked[0]?.originalColumn ?? vscode.ViewColumn.One;

        const newFileTab = this.findTabByUri(externalUri);
        const newFileColumn = newFileTab?.group.viewColumn;

        // If file already opened in the original column, just close the SOPS documents
        if (newFileColumn === originalColumn) {
            for (const doc of tracked) {
                await this.closeTab(vscode.Uri.parse(doc.docUri));
            }
            this.trackedDocs.clear();

            if (sopsColumn !== undefined) {
                await this.closeEmptyTabGroup(sopsColumn);
            }
            return;
        }

        // File opened in wrong column (SOPS column) - relocate it
        if (newFileTab) {
            await vscode.window.tabGroups.close(newFileTab.tab);
        }

        for (const doc of tracked) {
            await this.closeTab(vscode.Uri.parse(doc.docUri));
        }

        this.trackedDocs.clear();

        if (sopsColumn !== undefined) {
            await this.closeEmptyTabGroup(sopsColumn);
        }

        // Small delay to let VS Code settle, then re-open in target column
        await new Promise(resolve => setTimeout(resolve, 50));

        try {
            const document = await vscode.workspace.openTextDocument(externalUri);
            await vscode.window.showTextDocument(document, {
                viewColumn: originalColumn,
                preview: true,
                preserveFocus: false
            });
        } catch {
            // Failed to re-open file
        }
    }

    /**
     * Find a tab by its URI across all tab groups
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

    /**
     * Close an empty tab group if it exists at the given column
     */
    private async closeEmptyTabGroup(viewColumn: vscode.ViewColumn): Promise<void> {
        const tabGroup = vscode.window.tabGroups.all.find(g => g.viewColumn === viewColumn);

        if (tabGroup && tabGroup.tabs.length === 0) {
            try {
                await vscode.window.tabGroups.close(tabGroup);
            } catch {
                // Tab group may already be closed
            }
        }
    }

    dispose(): void {
        this.disposables.forEach(d => d.dispose());
        this.trackedDocs.clear();
    }
}
