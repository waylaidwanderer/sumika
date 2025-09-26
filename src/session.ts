import { AcpProcess } from './acp';
import type { SSEStreamingApi } from 'hono/streaming';
import { promises as fs } from 'fs';
import * as path from 'path';
import { debounce, DebouncedFunc } from 'lodash';
import * as mime from 'mime-types';
import {
    SessionData,
    Message,
    UserMessage,
    AgentMessage,
    ThoughtMessage,
    ToolCallMessage,
    PromptContent,
} from '@waylaidwanderer/sumika-types';
import { WorkspaceManager } from './workspaces';
import { loadSettings } from './settings';
import { logger } from './logger';

const HISTORY_SPLIT_RATIO = 0.7;

const COMPRESSION_PROMPT = `
You are the component that summarizes internal chat history into a given structure.

When the conversation history grows too large, you will be invoked to distill the entire history into a concise, structured XML snapshot. This snapshot is CRITICAL, as it will become the agent's *only* memory of the past. The agent will resume its work based solely on this snapshot. All crucial details, plans, errors, and user directives MUST be preserved.

First, you will think through the entire history in a private <scratchpad>. Review the user's overall goal, the agent's actions, tool outputs, file modifications, and any unresolved questions. Identify every piece of information that is essential for future actions.

After your reasoning is complete, generate the final <state_snapshot> XML object. Be incredibly dense with information. Omit any irrelevant conversational filler.

The structure MUST be as follows:

<state_snapshot>
    <overall_goal>
        <!-- A single, concise sentence describing the user's high-level objective. -->
        <!-- Example: "Refactor the authentication service to use a new JWT library." -->
    </overall_goal>

    <key_knowledge>
        <!-- Crucial facts, conventions, and constraints the agent must remember based on the conversation history and interaction with the user. Use bullet points. -->
        <!-- Example:
         - Build Command: \`npm run build\`
         - Testing: Tests are run with \`npm test\`. Test files must end in \`.test.ts\`.
         - API Endpoint: The primary API endpoint is \`https://api.example.com/v2\`.
         
        -->
    </key_knowledge>

    <file_system_state>
        <!-- List files that have been created, read, modified, or deleted. Note their status and critical learnings. -->
        <!-- Example:
         - CWD: \`/home/user/project/src\`
         - READ: \`package.json\` - Confirmed 'axios' is a dependency.
         - MODIFIED: \`services/auth.ts\` - Replaced 'jsonwebtoken' with 'jose'.
         - CREATED: \`tests/new-feature.test.ts\` - Initial test structure for the new feature.
        -->
    </file_system_state>

    <recent_actions>
        <!-- A summary of the last few significant agent actions and their outcomes. Focus on facts. -->
        <!-- Example:
         - Ran \`grep 'old_function'\` which returned 3 results in 2 files.
         - Ran \`npm run test\`, which failed due to a snapshot mismatch in \`UserProfile.test.ts\`.
         - Ran \`ls -F static/\` and discovered image assets are stored as \`.webp\`.
        -->
    </recent_actions>

    <current_plan>
        <!-- The agent's step-by-step plan. Mark completed steps. -->
        <!-- Example:
         1. [DONE] Identify all files using the deprecated 'UserAPI'.
         2. [IN PROGRESS] Refactor \`src/components/UserProfile.tsx\` to use the new 'ProfileAPI'.
         3. [TODO] Refactor the remaining files.
         4. [TODO] Update tests to reflect the API change.
        -->
    </current_plan>
</state_snapshot>
`;

interface InMemorySession extends SessionData {
    streamController?: SSEStreamingApi;
    acpSessionId?: string;
    isNewProcess?: boolean;
}

let messageIdCounter = 0;

function _getPromptCharCount(promptContent: PromptContent[]): number {
    return promptContent
        .map(p => (p.type === 'text' ? p.text : ''))
        .join('').length;
}

export class SessionManager {
    private sessions = new Map<string, InMemorySession>();
    private acpToLogical = new Map<string, string>();
    private _debouncedSave: DebouncedFunc<(sessionId: string) => void> | ((sessionId: string) => void);
    private workspaceManager: WorkspaceManager;
    private SESSIONS_DIR: string;
    private acpProcess?: AcpProcess;

    constructor(workspaceManager: WorkspaceManager) {
        this.workspaceManager = workspaceManager;
        this.SESSIONS_DIR = path.join(this.workspaceManager.sumikaDir, 'sessions');

        const performSave = async (sessionId: string) => {
            const session = this.sessions.get(sessionId);
            if (!session) return;

            try {
                const sessionDir = path.join(this.SESSIONS_DIR, session.workspaceId);
                await fs.mkdir(sessionDir, { recursive: true });
                const filePath = path.join(sessionDir, `${sessionId}.json`);
                const dataToSave = { ...session };
                delete dataToSave.streamController;
                await fs.writeFile(filePath, JSON.stringify(dataToSave, null, 2), 'utf-8');
            } catch (error) {
                logger.error({ err: error, sessionId }, `Error saving session ${sessionId}`);
            }
        };

        if (process.env.NODE_ENV === 'test') {
            this._debouncedSave = performSave;
        } else {
            this._debouncedSave = debounce(performSave, 1500);
        }

        if (process.env.NODE_ENV !== 'test') {
            this._loadSessionsFromDir();
        }
    }

    private _updateMessageIdCounter() {
        let maxId = -1;
        for (const session of this.sessions.values()) {
            for (const message of session.messages) {
                if (message.id.startsWith('msg-')) {
                    const num = parseInt(message.id.split('-')[1], 10);
                    if (!isNaN(num) && num > maxId) {
                        maxId = num;
                    }
                }
            }
        }
        messageIdCounter = maxId + 1;
        logger.info(`Message ID counter initialized to ${messageIdCounter}`);
    }

    private _setupEventHandlers(process: AcpProcess) {
        process.on('chunk', (data: any) => {
            const { sessionId: acpSessionId, ...rest } = data || {};
            if (!acpSessionId) return;
            const logicalId = this.acpToLogical.get(acpSessionId) || acpSessionId;
            this._handleAgentResponse(logicalId, { type: 'chunk', ...rest });
        });
        process.on('end', (data: any) => {
            const { sessionId: acpSessionId, ...rest } = data || {};
            if (!acpSessionId) return;
            const logicalId = this.acpToLogical.get(acpSessionId) || acpSessionId;
            this._handleAgentResponse(logicalId, { type: 'end', ...rest });
        });
        process.on('permission_request', (data: any) => {
            const { sessionId: acpSessionId, ...rest } = data || {};
            if (!acpSessionId) return;
            const logicalId = this.acpToLogical.get(acpSessionId) || acpSessionId;
            this._handleAgentResponse(logicalId, { type: 'permission_request', ...rest });
        });
        process.on('error', (data: any) => {
            const { sessionId: acpSessionId, ...rest } = data || {};
            if (!acpSessionId) {
                // deliver raw error if mapping is unavailable
                this._handleAgentResponse((rest as any)?.sessionId || 'unknown', { type: 'error', ...rest });
                return;
            }
            const logicalId = this.acpToLogical.get(acpSessionId) || acpSessionId;
            this._handleAgentResponse(logicalId, { type: 'error', ...rest });
        });
    }

    private _emitHistoryCompressed(sessionId: string, summaryMessage: Message) {
        const session = this.sessions.get(sessionId);
        if (session?.streamController) {
            try {
                session.streamController.write(JSON.stringify({
                    type: 'history_compressed',
                    summaryMessage,
                }) + '\n');
            } catch (e) {
                logger.error({ err: e, sessionId }, "Error writing history_compressed event to stream");
            }
        }
    }

    private _handleAgentResponse(sessionId: string, data: any) {
        const session = this.sessions.get(sessionId);
        if (!session) return;


        if (data.type === 'chunk' && data.sessionUpdate === 'tool_call' && data.toolCallId) {
            const toolName = data.toolCallId.split('-')[0];
            if (toolName) {
                const formattedName = toolName
                    .replace(/_/g, ' ')
                    .replace(/\b\w/g, (l: string) => l.toUpperCase());
                data.title = `${formattedName}: ${data.title}`;
            }
        }

        switch (data.type) {
            case 'end':
                session.status = 'idle';
                break;

            case 'permission_request':
                const toolCall = data.toolCall;
                const existingToolCallMsg = session.messages.find(
                    (m): m is ToolCallMessage => m.type === 'tool_call' && m.toolCallId === toolCall.toolCallId
                );

                if (existingToolCallMsg) {
                    existingToolCallMsg.status = 'awaiting_permission';
                    existingToolCallMsg.requestId = data.requestId;
                    existingToolCallMsg.options = data.options;
                } else {
                    const diffContent = toolCall.content?.find((c: any) => c.type === 'diff');
                    if (diffContent) {
                        toolCall.details = {
                            path: diffContent.path,
                            oldContent: diffContent.oldText,
                            content: diffContent.newText,
                            rawContent: JSON.stringify(toolCall.content, null, 2),
                        };
                    }

                    session.messages.push({
                        id: `msg-${messageIdCounter++}`,
                        type: 'tool_call',
                        toolCallId: toolCall.toolCallId,
                        kind: toolCall.kind,
                        title: toolCall.title,
                        input: toolCall.content?.map((c: any) => c.text || '').join('\n') || '',
                        output: '',
                        status: 'awaiting_permission',
                        details: toolCall.details,
                        requestId: data.requestId,
                        options: data.options,
                    });
                }
                break;

            case 'chunk':
                this._handleChunk(session, data);
                break;
            
            case 'error':

                {
                    const details = (data as any)?.error?.data?.details || (data as any)?.error?.message;
                    const text = typeof details === 'string' ? details : '';
                    if (text.includes('Session not found')) {
                        break;
                    }
                    if (/abort/i.test(text)) {

                        session.status = 'idle';
                        break;
                    }
                }
                session.messages.push({
                    id: `msg-${messageIdCounter++}`,
                    type: 'error',
                    error: (data as any).error || data,
                });
                session.status = 'idle';
                break;
        }

        if (session.streamController) {
            try {
                session.streamController.write(JSON.stringify(data) + '\n');
            } catch (e) {
                logger.error({ err: e }, "Error writing to stream, it might be closed");
            }
        }
        
        this._saveSessionToFile(sessionId);
    }

    private _handleChunk(session: InMemorySession, data: any) {
        const lastMessage = session.messages[session.messages.length - 1];

        switch (data.sessionUpdate) {
            case 'agent_message_chunk':
                if (lastMessage?.type === 'agent') {
                    lastMessage.content += data.content.text;
                    data.messageId = lastMessage.id;
                } else {
                    const newMessageId = `msg-${messageIdCounter++}`;
                    session.messages.push({
                        id: newMessageId,
                        type: 'agent',
                        content: data.content.text,
                    });
                    data.messageId = newMessageId;
                }
                break;

            case 'agent_thought_chunk':
                session.messages.push({
                    id: `msg-${messageIdCounter++}`,
                    type: 'thought',
                    content: data.content.text,
                });
                break;

            case 'tool_call':
                const toolCallDetails: { path?: string, content?: string, oldContent?: string, rawContent?: string } = {};
                const toolCallDiff = data.content?.find((c: any) => c.type === 'diff');
                if (toolCallDiff) {
                    toolCallDetails.path = toolCallDiff.path;
                    toolCallDetails.oldContent = toolCallDiff.oldText;
                    toolCallDetails.content = toolCallDiff.newText;
                }
                if (data.content) {
                    toolCallDetails.rawContent = JSON.stringify(data.content, null, 2);
                }

                session.messages.push({
                    id: `msg-${messageIdCounter++}`,
                    type: 'tool_call',
                    toolCallId: data.toolCallId,
                    kind: data.kind,
                    title: data.title,
                    input: data.content?.map((c: any) => c.text || '').join('\n') || '',
                    output: '',
                    status: data.status,
                    details: toolCallDetails,
                });
                break;
            
            case 'tool_call_update':
                const toolCallMsg = session.messages.find(
                    (m): m is ToolCallMessage => m.type === 'tool_call' && m.toolCallId === data.toolCallId
                );

                if (toolCallMsg) {
                    toolCallMsg.details = toolCallMsg.details || {};
                    if (data.content) {
                        toolCallMsg.details.rawContent = JSON.stringify(data.content, null, 2);
                        for (const item of data.content) {
                            if (item.type === 'diff') {
                                toolCallMsg.details.path = item.path;
                                toolCallMsg.details.oldContent = item.oldText;
                                toolCallMsg.details.content = item.newText;
                            } else {
                                const text = (item as any).content?.text ?? (item as any).text;
                                if (text) {
                                    toolCallMsg.output = (toolCallMsg.output || '') + text;
                                }
                            }
                        }
                    }

                    if (data.status) {
                        toolCallMsg.status = data.status;
                    }
                }
                break;
        }
    }

    public async processFileMentions(workspaceId: string, content: PromptContent[]): Promise<PromptContent[]> {
        const workspace = this.workspaceManager.getWorkspace(workspaceId);
        if (!workspace) {
            throw new Error(`Workspace with ID ${workspaceId} not found.`);
        }

        const finalContent: PromptContent[] = [];
        const mentionRegex = /@(\S+)/g;
        const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB

        for (const block of content) {
            if (block.type === 'text') {
                const matches = [...block.text.matchAll(mentionRegex)];
                const uniquePaths = [...new Set(matches.map(m => m[1]))];
                
                const resources: PromptContent[] = [];

                for (const relativePath of uniquePaths) {
                    const absolutePath = path.resolve(workspace.path, relativePath);

                    if (!absolutePath.startsWith(workspace.path)) {
                        logger.warn({ relativePath, workspacePath: workspace.path }, `Skipping file mention outside of workspace`);
                        continue;
                    }

                    try {
                        const stats = await fs.stat(absolutePath);
                        if (stats.isDirectory()) {
                            logger.warn({ relativePath }, `Skipping directory mention`);
                            continue;
                        }
                        if (stats.size > MAX_FILE_SIZE) {
                            logger.warn({ relativePath, size: stats.size, maxSize: MAX_FILE_SIZE }, `Skipping oversized file`);
                            continue;
                        }

                        const fileContent = await fs.readFile(absolutePath, 'utf-8');
                        const mimeType = mime.lookup(absolutePath) || 'application/octet-stream';

                        resources.push({
                            type: 'resource',
                            resource: {
                                uri: `file://${absolutePath}`,
                                mimeType: mimeType,
                                text: fileContent,
                            },
                        });
                    } catch (error) {
                        logger.warn({ relativePath, err: error }, `Skipping non-existent or unreadable file mention`);
                        continue;
                    }
                }
                finalContent.push(...resources, block);
            } else {
                finalContent.push(block);
            }
        }
        return finalContent;
    }

    public addUserMessage(sessionId: string, content: PromptContent[]): UserMessage {
        const session = this.sessions.get(sessionId);
        if (!session) {
            throw new Error('Session not found');
        }


        if (session.messages.filter(m => m.type === 'user').length === 0) {
            let firstText = content.find(c => c.type === 'text')?.text || 'Untitled Session';
            if (firstText.length > 100) {
                firstText = `${firstText.slice(0, 100)}...`;
            }
            session.name = firstText;
        }

        const sanitizedContent = content.map(block => {
            if (block.type === 'resource' && block.resource?.text) {
                const { text, ...resourceWithoutText } = block.resource;
                return {
                    ...block,
                    resource: resourceWithoutText,
                };
            }
            return block;
        });

        const newUserMessage: UserMessage = {
            id: `msg-${messageIdCounter++}`,
            type: 'user',
            content: sanitizedContent,
        };

        session.messages.push(newUserMessage);
        session.status = 'thinking';
        this._saveSessionToFile(sessionId);
        return newUserMessage;
    }

    private async _loadSessionsFromDir() {
        try {
            const workspaceDirs = await fs.readdir(this.SESSIONS_DIR, { withFileTypes: true });
            for (const workspaceDir of workspaceDirs) {
                if (workspaceDir.isDirectory()) {
                    const workspaceId = workspaceDir.name;
                    const sessionFiles = await fs.readdir(path.join(this.SESSIONS_DIR, workspaceId));
                    for (const file of sessionFiles) {
                        if (path.extname(file) === '.json') {
                            const sessionId = path.basename(file, '.json');
                            try {
                                const content = await fs.readFile(path.join(this.SESSIONS_DIR, workspaceId, file), 'utf-8');
                                const sessionData: SessionData = JSON.parse(content);
                                const inMemorySession: InMemorySession = {
                                    ...sessionData,
                                    status: 'disconnected', // Always start as disconnected
                                    streamController: undefined,
                                };
                                this.sessions.set(sessionId, inMemorySession);
                            } catch (error) {
                                logger.error({ err: error, sessionId, file }, `Error loading session file ${file}`);
                            }
                        }
                    }
                }
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                logger.error({ err: error }, 'Error loading sessions from disk');
            }

        }
        this._updateMessageIdCounter();
    }

    private _transformMcpServers(mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> = {}) {
        const serverList = Object.entries(mcpServers);

        const transformedServers = serverList.map(([name, serverConfig]) => {
            const transformedEnv = Object.entries(serverConfig.env).map(([envName, envValue]) => {
                return { name: envName, value: envValue };
            });

            return {
                name: name,
                command: serverConfig.command,
                args: serverConfig.args,
                env: transformedEnv,
            };
        });

        return transformedServers;
    }

    async createSession(workspaceId: string): Promise<string> {
        const workspace = this.workspaceManager.getWorkspace(workspaceId);
        if (!workspace) {
            throw new Error(`Workspace with ID ${workspaceId} not found.`);
        }

        const globalSettings = await loadSettings(this.workspaceManager.sumikaDir);
        const mergedServers = { ...(globalSettings.mcpServers || {}), ...(workspace.mcpServers || {}) };
        const mcpServers = this._transformMcpServers(mergedServers);

        if (!this.acpProcess) {
            throw new Error('ACP process is not initialized');
        }

        const result = await this.acpProcess.newSession({ cwd: workspace.path, mcpServers });
        const sessionId = result.sessionId as string;

        const newSession: InMemorySession = {
            id: sessionId,
            workspaceId: workspaceId,
            name: 'Untitled Session',
            messages: [],
            pinned: false,
            createdAt: new Date().toISOString(),
            status: 'idle',
            acpSessionId: sessionId,
            isNewProcess: true,
        };

        this.sessions.set(sessionId, newSession);
        this.acpToLogical.set(sessionId, sessionId);
        await this._saveSessionToFile(sessionId);
        return sessionId;
    }

    async reloadSession(sessionId: string): Promise<string | undefined> {
        const existing = this.sessions.get(sessionId);
        if (!existing) return undefined;

        const workspace = this.workspaceManager.getWorkspace(existing.workspaceId);
        if (!workspace) {
            throw new Error(`Workspace ${existing.workspaceId} not found for session ${sessionId}`);
        }

        const globalSettings = await loadSettings(this.workspaceManager.sumikaDir);
        const mergedServers = { ...(globalSettings.mcpServers || {}), ...(workspace.mcpServers || {}) };
        const mcpServers = this._transformMcpServers(mergedServers);

        if (!this.acpProcess) {
            throw new Error('ACP process is not initialized');
        }

        const result = await this.acpProcess.newSession({ cwd: workspace.path, mcpServers });
        const newAcpId = result.sessionId as string;
        if (existing.acpSessionId) {
            this.acpToLogical.delete(existing.acpSessionId);
        }
        existing.acpSessionId = newAcpId;
        existing.isNewProcess = true;
        existing.status = 'idle';
        existing.isUpdating = false;
        this.acpToLogical.set(newAcpId, sessionId);
        this._saveSessionToFile(sessionId);
        return sessionId;
    }

    public async branchSession(originalSessionId: string, branchFromMessageId: string): Promise<SessionData> {
        const originalSession = this.sessions.get(originalSessionId);
        if (!originalSession) {
            throw new Error(`Original session with ID ${originalSessionId} not found.`);
        }

        const branchFromIndex = originalSession.messages.findIndex(m => m.id === branchFromMessageId);
        if (branchFromIndex === -1) {
            throw new Error(`Message with ID ${branchFromMessageId} not found in session ${originalSessionId}.`);
        }

        const messageToBranchFrom = originalSession.messages[branchFromIndex];
        if (messageToBranchFrom.type !== 'agent') {
            throw new Error(`Branching is only supported from agent messages.`);
        }

        const newHistory = originalSession.messages.slice(0, branchFromIndex + 1);

        const newSessionId = await this.createSession(originalSession.workspaceId);
        const newSession = this.sessions.get(newSessionId);

        if (!newSession) {
            // This should be an impossible state, but typescript demands a check.
            throw new Error('Failed to create and retrieve the new session.');
        }

        const branchTagRegex = /^\(Branch @ [^\)]+\) /;
        const baseName = originalSession.name.replace(branchTagRegex, '');
        newSession.name = `(Branch @ ${new Date().toLocaleTimeString()}) ${baseName}`;
        newSession.messages = newHistory;

        await this._saveSessionToFile(newSessionId);


        return this.getSession(newSessionId)!;
    }

    public async initialize(): Promise<void> {
        if (this.acpProcess) return;


        let settings;
        try {
            settings = await loadSettings(this.workspaceManager.sumikaDir);
        } catch (e) {
            settings = { env: {}, mcpServers: {} };
        }

        const process = new AcpProcess({
            onExit: (code) => {
                logger.error({ code }, `--- SessionManager: Central AcpProcess exited with code ${code} ---`);
                this.handleProcessCrash();
            },
            customEnv: settings.env,
            customAcpCommand: settings.customAcpCommand,
        });

        await process.connect();
        this._setupEventHandlers(process);
        this.acpProcess = process;
    }

    public restartAgentProcess(): void {
        logger.info('--- SessionManager: Received request to restart agent process ---');
        if (this.acpProcess) {

            this.acpProcess.kill();
        } else {
            this.handleProcessCrash();
        }
    }

    private handleProcessCrash(): void {

        this.acpToLogical.clear();
        for (const [sessionId, session] of this.sessions.entries()) {
            session.status = 'disconnected';
            try {
                this._saveSessionToFile(sessionId);

                if (session.streamController) {
                    try {
                        session.streamController.write(JSON.stringify({ type: 'error', error: 'Agent process crashed. Session disconnected.' }) + '\n');
                    } catch {}
                }
            } catch {}
        }


        this.acpProcess = undefined;
        this.initialize().catch(err => {
            logger.error({ err }, 'Failed to restart ACP process');
        });
    }

    private _composePrompt(sessionId: string, currentContent: PromptContent[]): PromptContent[] {
        const session = this.sessions.get(sessionId);
        if (!session) {
            return currentContent;
        }


        let lastSummaryIndex = -1;
        for (let i = session.messages.length - 1; i >= 0; i--) {
            if (session.messages[i].type === 'history_summary') {
                lastSummaryIndex = i;
                break;
            }
        }

        let messagesToCompose: Message[];
        let useDefaultHeader = true;

        if (lastSummaryIndex !== -1) {

            if (lastSummaryIndex === session.messages.length - 1) {
                messagesToCompose = [session.messages[lastSummaryIndex]];
            } else {
                messagesToCompose = session.messages.slice(lastSummaryIndex);
            }

        } else {

            messagesToCompose = [...session.messages];
        }


        const historyContent = this._messagesToPromptContent(messagesToCompose);
        
        if (historyContent.length > 0 && useDefaultHeader) {
            const historyHeader: PromptContent = { type: 'text', text: '# Chat History\n\n' };
            const historyFooter: PromptContent = { type: 'text', text: '\n---\n' };
            return [historyHeader, ...historyContent, historyFooter, ...currentContent];
        } else if (historyContent.length > 0) {
            return [...historyContent, ...currentContent];
        }

        return currentContent;
    }

    public async prompt(sessionId: string, content: PromptContent[]): Promise<void> {
        const session = this.sessions.get(sessionId);
        if (!session) throw new Error('Session not found');
        if (!this.acpProcess) throw new Error('Agent not initialized');


        const currentAcpId = session.acpSessionId || sessionId;
        if (!this.acpToLogical.has(currentAcpId)) {
            await this.reloadSession(sessionId);
        }
        

        const finalContent = session.isNewProcess ? this._composePrompt(sessionId, content) : content;


        this.markHistoryAsSent(sessionId);

        const refreshed = this.sessions.get(sessionId);
        const acpId = refreshed?.acpSessionId || session.acpSessionId || sessionId;
        this.acpProcess.prompt(acpId, { prompt: finalContent });
    }

    public async compressHistory(sessionId: string): Promise<boolean> {
        logger.debug({ sessionId }, 'Starting history compression.');
        const session = this.sessions.get(sessionId);
        if (!session || !this.acpProcess) {
            logger.warn({ sessionId }, 'Compression failed: session or ACP process not found.');
            return false;
        }

        const originalMessages = [...session.messages];
        const originalCharCount = originalMessages.map(m => JSON.stringify(m)).join('').length;
        logger.debug({ sessionId, originalCharCount, messageCount: originalMessages.length }, 'Original history stats.');


        let charCount = 0;
        let splitIndex = -1;
        for (let i = 0; i < originalMessages.length; i++) {
            charCount += JSON.stringify(originalMessages[i]).length;
            if (charCount / originalCharCount >= HISTORY_SPLIT_RATIO) {
                splitIndex = i;
                break;
            }
        }

        if (splitIndex === -1) {
            logger.warn({ sessionId }, 'Compression failed: history too short to split.');
            return false; // History too short to split
        }
        logger.debug({ sessionId, initialSplitIndex: splitIndex }, 'Calculated initial split index.');


        let finalSplitIndex = -1;
        for (let i = splitIndex; i >= 0; i--) {
            if (originalMessages[i].type === 'user') {
                finalSplitIndex = i;
                break;
            }
        }


        if (finalSplitIndex === -1) {
            logger.warn({ sessionId }, 'Compression failed: no user turn found in the history segment to be summarized.');
            return false;
        }
        splitIndex = finalSplitIndex;
        logger.debug({ sessionId, finalSplitIndex: splitIndex }, 'Adjusted split index to user turn.');

        const historyToSummarize = originalMessages.slice(0, splitIndex);
        if (historyToSummarize.length === 0) {
            logger.warn({ sessionId }, 'Compression failed: no history to summarize after segmentation.');
            return false;
        }
        const historyToKeep = originalMessages.slice(splitIndex);
        logger.debug({ sessionId, toSummarize: historyToSummarize.length, toKeep: historyToKeep.length }, 'History segmented.');


        try {
            const tempSessionId = `temp-compression-${Date.now()}`;
            const summaryPrompt: PromptContent[] = [
                ...this._messagesToPromptContent(historyToSummarize),
                { type: 'text', text: COMPRESSION_PROMPT },
            ];
            

            const workspace = this.workspaceManager.getWorkspace(session.workspaceId);
            if (!workspace) throw new Error('Workspace not found');
            const tempAcpSession = await this.acpProcess.newSession({ cwd: workspace.path, mcpServers: [] });
            const tempAcpId = tempAcpSession.sessionId;
            this.acpToLogical.set(tempAcpId, tempSessionId);
            
            const responsePromise = new Promise<string>((resolve, reject) => {
                let summaryText = '';
                const onChunk = (data: any) => {
                    if (data.sessionId === tempAcpId && data.sessionUpdate === 'agent_message_chunk') {
                        summaryText += data.content.text;
                    }
                };
                const onEnd = (data: any) => {
                    if (data.sessionId === tempAcpId) {
                        this.acpProcess?.off('chunk', onChunk);
                        this.acpProcess?.off('end', onEnd);
                        this.acpProcess?.off('error', onError);
                        resolve(summaryText);
                    }
                };
                const onError = (data: any) => {
                     if (data.sessionId === tempAcpId) {
                        this.acpProcess?.off('chunk', onChunk);
                        this.acpProcess?.off('end', onEnd);
                        this.acpProcess?.off('error', onError);
                        reject(data.error);
                    }
                };

                this.acpProcess?.on('chunk', onChunk);
                this.acpProcess?.on('end', onEnd);
                this.acpProcess?.on('error', onError);
            });

            logger.debug({ sessionId, tempAcpId }, 'Sending summarization prompt to temporary ACP session.');
            await this.acpProcess.prompt(tempAcpId, { prompt: summaryPrompt });
            const summaryText = await responsePromise;

            const summaryMatch = summaryText.match(/<state_snapshot>([\s\S]*)<\/state_snapshot>/);
            if (!summaryMatch) {
                logger.error({ sessionId, response: summaryText }, "Compression failed: could not find <state_snapshot> in model response.");
                throw new Error("The agent's summary was malformed. Please try again.");
            }
            const extractedSummary = summaryMatch[0];
            logger.debug({ sessionId }, 'Successfully extracted summary from agent response.');


            const summaryMessage: Message = {
                id: `compression-${Date.now()}`,
                type: 'history_summary',
                summary: extractedSummary,
                after: historyToKeep.length > 0 ? historyToKeep[historyToKeep.length - 1].id : undefined,
            };

            const newMessages = [
                ...historyToSummarize,
                summaryMessage,
                ...historyToKeep,
            ];


            const originalPromptCharCount = _getPromptCharCount(this._composePrompt(sessionId, []));


            session.messages = newMessages;
            const newCharCount = _getPromptCharCount(this._composePrompt(sessionId, []));
            
            logger.debug({ sessionId, newPromptCharCount: newCharCount, originalPromptCharCount }, 'Safety check comparison.');
            if (newCharCount >= originalPromptCharCount) {
                logger.warn({ sessionId, newCharCount, originalPromptCharCount }, `Compression aborted: new prompt context is not smaller than original.`);

                return false;
            }


            this._saveSessionToFile(sessionId);
            this._emitHistoryCompressed(sessionId, summaryMessage);
            logger.debug({ sessionId, newCharCount }, 'History compression successful.');
            return true;

        } catch (error) {
            logger.error({ err: error, sessionId }, 'Error during history compression.');

            return false;
        }
    }

    private _messagesToPromptContent(messages: Message[]): PromptContent[] {
        const content: PromptContent[] = [];
        for (const m of messages) {
            if (m.type === 'thought') continue;
            let messageText = '';
            switch (m.type) {
                case 'user':
                    messageText = m.content.map(c => {
                        if (c.type === 'text') return c.text;
                        if (c.type === 'resource') return `[Embedded File: ${c.resource.uri}]`;
                        return '';
                    }).join(' ');
                    content.push({ type: 'text', text: `## User\n${messageText}\n\n` });
                    break;
                case 'agent':
                    messageText = (m as any).content;
                    content.push({ type: 'text', text: `## Agent\n${messageText}\n\n` });
                    break;
                case 'tool_call':
                    const t = m as any;
                    messageText = `## Tool Call: \`${t.title}\`\n*Status: ${t.status}*\n`;
                    if (t.input) messageText += `*Input:*\n\`\`\`\n${t.input}\n\`\`\`\n`;
                    if (t.output) messageText += `*Output:*\n\`\`\`\n${t.output}\n\`\`\`\n`;
                    content.push({ type: 'text', text: messageText });
                    break;
                case 'history_summary':
                    content.push({ type: 'text', text: (m as any).summary });
                    break;
            }
        }
        return content;
    }

    public cancel(sessionId: string) {
        if (!this.acpProcess) throw new Error('Agent not initialized');
        const session = this.sessions.get(sessionId);
        const acpId = session?.acpSessionId || sessionId;
        this.acpProcess.cancel(acpId);
    }

    public sendPermissionResponse(requestId: number, outcome: any) {
        if (!this.acpProcess) throw new Error('Agent not initialized');
        this.acpProcess.sendPermissionResponse(requestId, outcome);
    }

    public getAllSessions(options: { workspaceId?: string; limit?: number; offset?: number; view?: 'summary' | 'full' } = {}): SessionData[] {
        const { workspaceId, limit = 20, offset = 0, view = 'full' } = options;

        const allSessions = Array.from(this.sessions.values())
            .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

        let filtered = workspaceId 
            ? allSessions.filter(s => s.workspaceId === workspaceId)
            : allSessions;

        const paginated = filtered.slice(offset, offset + limit);
            
        return paginated.map(s => {
            const { streamController, ...rest } = s;
            if (view === 'summary') {
                if (rest.messages && rest.messages.length > 0) {
                    rest.lastMessage = rest.messages[rest.messages.length - 1];
                }
                rest.messages = []; // Replace with empty array instead of deleting
            }
            return rest;
        });
    }

    public getSession(sessionId: string): SessionData | undefined {
        const session = this.sessions.get(sessionId);
        if (!session) return undefined;
        const { streamController, ...rest } = session;
        return rest;
    }

    public markHistoryAsSent(sessionId: string) {
        const session = this.sessions.get(sessionId);
        if (session) {
            session.isNewProcess = false;
        }
    }

    public updatePermissionRequestMessage(sessionId: string, requestId: number, optionId: string) {
        const session = this.sessions.get(sessionId);
        if (!session) return;

        const message = session.messages.find(
            (m): m is ToolCallMessage => m.type === 'tool_call' && m.requestId === requestId
        );

        if (message) {
            message.selectedOptionId = optionId;

            const selectedOption = message.options?.find(opt => opt.optionId === optionId);
            if (selectedOption && selectedOption.kind.startsWith('reject')) {
                message.status = 'cancelled';
                session.status = 'idle';
            }

            this._saveSessionToFile(sessionId);
        }
    }

    public updateSession(sessionId: string, updates: Partial<Pick<SessionData, 'name' | 'pinned'>>): SessionData | undefined {
        const session = this.sessions.get(sessionId);
        if (!session) return undefined;

        if (updates.name !== undefined) {
            session.name = updates.name;
        }
        if (updates.pinned !== undefined) {
            session.pinned = updates.pinned;
        }

        this._saveSessionToFile(sessionId);
        
        const { streamController, ...rest } = session;
        return rest;
    }

    public deleteSession(sessionId: string): boolean {
        const session = this.sessions.get(sessionId);
        if (!session) return false;

        // Remove ACP mapping if present
        if (session.acpSessionId) {
            this.acpToLogical.delete(session.acpSessionId);
        }
        // Also remove any initial mapping that used logical ID as ACP ID
        this.acpToLogical.delete(sessionId);

        this._deleteSessionFile(sessionId);
        this.sessions.delete(sessionId);
        return true;
    }

    registerStream(sessionId: string, stream: SSEStreamingApi) {
        const session = this.sessions.get(sessionId);
        if (session) {
            session.streamController = stream;
        }
    }



    public exportSessionToMarkdown(sessionId: string, options?: { excludeTypes?: string[] }): string {
        const session = this.sessions.get(sessionId);
        if (!session) return '';

        let markdown = '';
        for (const message of session.messages) {
            if (options?.excludeTypes?.includes(message.type)) {
                continue;
            }
            switch (message.type) {
                case 'user':
                    const userText = message.content.map(c => {
                        if (c.type === 'text') return c.text;
                        if (c.type === 'resource') return `[Embedded File: ${c.resource.uri}]`;
                        return '';
                    }).join(' ');
                    markdown += `## User\n${userText}\n\n`;
                    break;
                case 'agent':
                    markdown += `## Agent\n${message.content}\n\n`;
                    break;
                case 'thought':
                    markdown += `## Thought\n${message.content}\n\n`;
                    break;
                case 'tool_call':
                    if (message.status === 'awaiting_permission' || message.selectedOptionId) {
                        markdown += `## Permission Request: \`${message.title}\`\n`;
                        if (message.selectedOptionId) {
                            markdown += `*User responded: ${message.selectedOptionId}*\n\n`;
                        } else {
                            markdown += `*Awaiting user response.*\n\n`;
                        }
                    } else {
                        markdown += `## Tool Call: \`${message.title}\`\n`;
                        markdown += `*Status: ${message.status}*\n`;
                        if (message.input) markdown += `*Input:*\n\`\`\`\n${message.input}\n\`\`\`\n`;
                        if (message.output) markdown += `*Output:*\n\`\`\`\n${message.output}\n\`\`\`\n`;
                        markdown += '\n';
                    }
                    break;
                case 'history_summary':
                    markdown += `## Compressed History\n\n> ${message.summary.replace(/\n/g, '\n> ')}\n\n`;
                    break;
            }
        }
        return markdown;
    }

    private _saveSessionToFile(sessionId: string) {
        this._debouncedSave(sessionId);
    }

    private async _deleteSessionFile(sessionId: string) {
        const session = this.sessions.get(sessionId);
        if (!session) return;
        try {
            const filePath = path.join(this.SESSIONS_DIR, session.workspaceId, `${sessionId}.json`);
            await fs.unlink(filePath);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                logger.error({ err: error, sessionId }, `Error deleting session file for ${sessionId}`);
            }
        }
    }

    public clear() {
        this.sessions.clear();
    }
}
