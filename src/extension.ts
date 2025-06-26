import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';

/** One row in the evaluation JSON dataset */
interface DatasetRecord {
    input:  string; // user message sent together with the prompt file
    waitMs: number; // time to wait (best-effort) before exporting the chat
    [key: string]: unknown;  // additional fields ignored
}

const CHAT_EXPORT = 'chat.json'; // VS Code writes the export next to the prompt by default

export function activate(ctx: vscode.ExtensionContext) {
    ctx.subscriptions.push(
        vscode.commands.registerCommand('extension.evaluatePrompt', evaluatePrompt),
    );
}

export function deactivate() { /* nothing to do */ }

async function evaluatePrompt() {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return vscode.window.showErrorMessage('Open a workspace first');

    const datasetPath = await pickDataset(root);
    if (!datasetPath) return vscode.window.showErrorMessage('Invalid dataset file');;

    const records = await loadDataset(datasetPath);
    if (!records) return vscode.window.showErrorMessage('Invalid dataset contents');;

    const promptUri = vscode.window.activeTextEditor?.document.uri;
    if (!promptUri || !promptUri.fsPath.endsWith('.prompt.md')) {
        return vscode.window.showErrorMessage('Open a *.prompt.md file to evaluate');
    }

    const resultsFile = await initResultsFile(root, promptUri);
    for (const rec of records) {
        if (typeof rec.input !== 'string') continue;

        await vscode.commands.executeCommand('workbench.action.chat.newChat');
        await vscode.commands.executeCommand('workbench.action.chat.attachFile', promptUri);
        await vscode.commands.executeCommand('workbench.action.chat.open', rec.input);

        await sleep(rec.waitMs);  // let the chat finish, as we cannot query the status
        await vscode.commands.executeCommand('workbench.action.chat.export');
        await sleep(500);  // give VS Code time to write the file

        const exportDir = path.dirname(promptUri.fsPath); // default destination
        await collectAndAppendChatExport(exportDir, resultsFile);
    }
}

/** Prompt user to select a JSON dataset file */
async function pickDataset(root: string): Promise<string | undefined> {
    const picked = await vscode.window.showOpenDialog({
        defaultUri: vscode.Uri.file(root),
        openLabel:  'Select dataset JSON',
        canSelectMany: false,
        filters: { JSON: ['json'] },
    });
    return picked?.[0]?.fsPath;
}

/** Load the JSON dataset into memory */
async function loadDataset(file: string): Promise<DatasetRecord[] | undefined> {
    try {
        const json = JSON.parse(await fs.readFile(file, 'utf8'));
        if (Array.isArray(json)) return json as DatasetRecord[];
    } catch (e) {/* fall-through */ }
}

/** Prepare results file: <root>/.github/evals/<prompt>/<ISO-datetime>.json */
async function initResultsFile(root: string, promptUri: vscode.Uri): Promise<string> {
    const promptName = path.basename(promptUri.fsPath, '.prompt.md');
    const timestamp = new Date()
        .toISOString()          // 2023-08-07T10:20:30.123Z
        .slice(0, 16)           // 2023-08-07T10:20
        .replace(/[-T:]/g, '')  // 202308071020
        .replace(/(\d{8})(\d{4})/, '$1-$2'); // 20230807-1020
    const evalDir    = path.join(root, '.github', 'evals', promptName);

    await fs.mkdir(evalDir, { recursive: true });

    const results = path.join(evalDir, `${timestamp}.json`);
    await fs.writeFile(results, '[]', { flag: 'wx' }).catch(() => void 0);

    return results;
}

/** Collect chat export from directory and append to consolidated results file */
async function collectAndAppendChatExport(exportDir: string, resultsFile: string) {
    const chatExportPath = path.join(exportDir, CHAT_EXPORT);
    if (!(await exists(chatExportPath))) return;

    try {
        const chatData = JSON.parse(await fs.readFile(chatExportPath, 'utf8'));
        await appendToResultsFile(resultsFile, chatData);
    } finally {
        await fs.rm(chatExportPath).catch(() => void 0);
    }
}

/** Append chat data to consolidated results file array */
async function appendToResultsFile(resultsFile: string, chatData: unknown) {
    let allResults: unknown[] = [];

    try {
        const existing = JSON.parse(await fs.readFile(resultsFile, 'utf8'));
        if (Array.isArray(existing)) allResults = existing;
    } catch {/* start with empty array */}

    allResults.push(chatData);
    await fs.writeFile(resultsFile, JSON.stringify(allResults, null, 2), 'utf8');
}

const sleep  = (ms: number) => new Promise(r => setTimeout(r, ms));
const exists = async (f: string) => fs.access(f).then(() => true).catch(() => false);
