import { EventEmitter } from 'node:events';

import {
    beforeEach,
    describe,
    expect, test, vi,
} from 'vitest';

import AcpProcess from './acp';
import { SessionManager } from './session';
import { WorkspaceManager } from './workspaces';

vi.mock('./acp', () => {
    const AcpProcess = vi.fn().mockImplementation(({ onExit }) => {
        const emitter = new EventEmitter();
        (emitter as any).connect = vi.fn().mockResolvedValue(undefined);
        (emitter as any).newSession = vi.fn().mockResolvedValue({ sessionId: 'mock-session-id' });
        (emitter as any).prompt = vi.fn().mockResolvedValue(undefined);
        (emitter as any).cancel = vi.fn();
        (emitter as any).sendPermissionResponse = vi.fn();
        (emitter as any).kill = vi.fn();
        // Store the onExit callback to simulate a crash
        (emitter as any)._simulateExit = (exitCode: number) => {
            if (onExit) {
                onExit(exitCode);
            }
        };
        return emitter;
    });
    return { default: AcpProcess };
});

vi.mock('./workspaces', () => {
    const WorkspaceManager = vi.fn().mockImplementation(() => ({
        getWorkspace: vi.fn().mockReturnValue({
            id: 'default',
            name: 'Default Workspace',
            path: '/tmp/default-workspace',
            createdAt: new Date().toISOString(),
            env: {},
        }),
        sumikaDir: '/tmp/test-home/.sumika',
    }));
    return { WorkspaceManager };
});

describe('SessionManager', () => {
    test('should create a new session and return a session ID', async () => {
        const workspaceManager = new WorkspaceManager();
        const manager = new SessionManager(workspaceManager);
        await manager.initialize();
        const sessionId = await manager.createSession('default');
        expect(sessionId).toBe('mock-session-id');
        const session = manager.getSession(sessionId);
        expect(session?.id).toBe('mock-session-id');
    });

    test('should name the session after the first user prompt', async () => {
        const workspaceManager = new WorkspaceManager();
        const manager = new SessionManager(workspaceManager);
        await manager.initialize();
        const sessionId = await manager.createSession('default');

        const sessionBefore = manager.getSession(sessionId);
        expect(sessionBefore?.name).toBe('Untitled Session');

        const firstPromptText = 'This is the first message.';
        const firstPromptContent = [{ type: 'text' as const, text: firstPromptText }];
        manager.addUserMessage(sessionId, firstPromptContent);

        const sessionAfter = manager.getSession(sessionId);
        expect(sessionAfter?.name).toBe(firstPromptText);

        // Ensure it doesn't change on the second message
        manager.addUserMessage(sessionId, [{ type: 'text' as const, text: 'This is the second message.' }]);
        const sessionFinal = manager.getSession(sessionId);
        expect(sessionFinal?.name).toBe(firstPromptText);
    });

    test('should set session status to "disconnected" on non-zero exit', async () => {
        const workspaceManager = new WorkspaceManager();
        const manager = new SessionManager(workspaceManager);
        await manager.initialize();
        const sessionId = await manager.createSession('default');

        const proc = (manager as any).acpProcess;
        expect(proc).toBeDefined();

        proc._simulateExit(1);

        const session = manager.getSession(sessionId);
        expect(session?.status).toBe('disconnected');
    });

    describe('_transformMcpServers', () => {
        test('should correctly convert object to array format with multiple env vars', () => {
            const workspaceManager = new WorkspaceManager();
            const manager = new SessionManager(workspaceManager);

            const mcpServersObject = {
                'python-tool': {
                    command: 'python',
                    args: ['-m', 'my_tool'],
                    env: { PYTHONUNBUFFERED: '1' },
                },
                'node-server': {
                    command: 'node',
                    args: ['server.js'],
                    env: { PORT: '8080', NODE_ENV: 'production' },
                },
            };

            // Access the private method for testing
            const transformed = (manager as any)._transformMcpServers(mcpServersObject);

            const expected = [
                {
                    name: 'python-tool',
                    command: 'python',
                    args: ['-m', 'my_tool'],
                    env: [{ name: 'PYTHONUNBUFFERED', value: '1' }],
                },
                {
                    name: 'node-server',
                    command: 'node',
                    args: ['server.js'],
                    env: [
                        { name: 'PORT', value: '8080' },
                        { name: 'NODE_ENV', value: 'production' },
                    ],
                },
            ];

            transformed.forEach((t: any) => t.env.sort((a: any, b: any) => a.name.localeCompare(b.name)));
            expected.forEach((e) => e.env.sort((a, b) => a.name.localeCompare(b.name)));
            transformed.sort((a: any, b: any) => a.name.localeCompare(b.name));
            expected.sort((a, b) => a.name.localeCompare(b.name));

            expect(transformed).toEqual(expected);
        });

        test('should handle empty input', () => {
            const workspaceManager = new WorkspaceManager();
            const manager = new SessionManager(workspaceManager);
            const transformed = (manager as any)._transformMcpServers({});
            expect(transformed).toEqual([]);
        });

        test('should handle servers with no env vars', () => {
            const workspaceManager = new WorkspaceManager();
            const manager = new SessionManager(workspaceManager);
            const mcpServersObject = {
                'simple-tool': {
                    command: 'ls',
                    args: ['-la'],
                    env: {},
                },
            };
            const transformed = (manager as any)._transformMcpServers(mcpServersObject);
            expect(transformed).toEqual([
                {
                    name: 'simple-tool',
                    command: 'ls',
                    args: ['-la'],
                    env: [],
                },
            ]);
        });
    });

    describe('compressHistory', () => {
        let manager: SessionManager;
        let sessionId: string;

        beforeEach(async () => {
            const workspaceManager = new WorkspaceManager();
            manager = new SessionManager(workspaceManager);
            await manager.initialize();
            sessionId = await manager.createSession('default');

            const { acpProcess } = (manager as any);
            acpProcess.prompt = vi.fn().mockImplementation(async (acpSessionId, { prompt }) => {
                const isCompression = prompt.some((p: any) => p.text?.includes('<state_snapshot>'));
                if (isCompression) {
                    // Simulate the agent returning a summary via chunks
                    const summary = '<state_snapshot><overall_goal>Test Goal</overall_goal></state_snapshot>';
                    const tempAcpId = [...(manager as any).acpToLogical.keys()].find((key) => (manager as any).acpToLogical.get(key).startsWith('temp-compression'));

                    // Simulate the async response flow
                    setTimeout(() => {
                        acpProcess.emit('chunk', {
                            sessionId: tempAcpId,
                            sessionUpdate: 'agent_message_chunk',
                            content: { text: summary },
                        });
                        acpProcess.emit('end', { sessionId: tempAcpId });
                    }, 50);
                }
            });
        });

        test('should compress history successfully', async () => {
            // 1. Populate history
            for (let i = 0; i < 10; i++) {
                manager.addUserMessage(sessionId, [{ type: 'text', text: `message ${i}` }]);
                (manager as any)._handleAgentResponse(sessionId, { type: 'chunk', sessionUpdate: 'agent_message_chunk', content: { text: `response ${i}` } });
            }
            const originalMessageCount = manager.getSession(sessionId)!.messages.length;

            // 2. Compress
            const result = await manager.compressHistory(sessionId);
            expect(result).toBe(true);

            // 3. Verify
            const session = manager.getSession(sessionId)!;
            expect(session.messages.length).toBe(originalMessageCount + 1);
            const summaryMessage = session.messages.find((m) => m.type === 'history_summary');
            expect(summaryMessage).toBeDefined();
        });

        test('should abort compression if new history is not smaller', async () => {
            // 1. Populate with short history
            manager.addUserMessage(sessionId, [{ type: 'text', text: 'short message' }]);
            (manager as any)._handleAgentResponse(sessionId, { type: 'chunk', sessionUpdate: 'agent_message_chunk', content: { text: 'short response' } });
            const originalMessages = [...manager.getSession(sessionId)!.messages];

            // 2. Compress
            const result = await manager.compressHistory(sessionId);
            expect(result).toBe(false);

            // 3. Verify history is unchanged
            const session = manager.getSession(sessionId)!;
            expect(session.messages).toEqual(originalMessages);
        });

        test('should snap split point to the nearest user turn', async () => {
            // 1. Build a long history that is definitely compressible
            for (let i = 0; i < 15; i++) {
                manager.addUserMessage(sessionId, [{ type: 'text', text: `This is user message number ${i}, which is part of a long conversation.` }]);
                (manager as any)._handleAgentResponse(sessionId, { type: 'chunk', sessionUpdate: 'agent_message_chunk', content: { text: `This is agent response number ${i}, adding more content.` } });
            }

            // 2. This is the turn that should be preserved
            manager.addUserMessage(sessionId, [{ type: 'text', text: 'user message to keep' }]);
            (manager as any)._handleAgentResponse(sessionId, { type: 'chunk', sessionUpdate: 'agent_message_chunk', content: { text: 'agent response to keep' } });

            const originalMessageCount = manager.getSession(sessionId)!.messages.length;
            expect(originalMessageCount).toBe(32); // 15 pairs + 1 pair

            // 3. Compress
            const result = await manager.compressHistory(sessionId);
            expect(result).toBe(true);

            // 4. Verify
            const newSession = manager.getSession(sessionId)!;
            expect(newSession.messages.length).toBe(originalMessageCount + 1);
            const summaryIndex = newSession.messages.findIndex((m) => m.type === 'history_summary');
            expect(summaryIndex).not.toBe(-1);
            // The message after the summary should be the first message of the "kept" history
            expect((newSession.messages[summaryIndex + 1] as any).content[0].text).toBe('This is user message number 10, which is part of a long conversation.');
        });
    });

    describe('Non-destructive compressHistory', () => {
        let manager: SessionManager;
        let sessionId: string;
        const summaryText = '<state_snapshot><overall_goal>Test Goal</overall_goal></state_snapshot>';

        beforeEach(async () => {
            const workspaceManager = new WorkspaceManager();
            manager = new SessionManager(workspaceManager);
            await manager.initialize();
            sessionId = await manager.createSession('default');

            const { acpProcess } = (manager as any);
            acpProcess.prompt = vi.fn().mockImplementation(async (acpSessionId, { prompt }) => {
                const isCompression = prompt.some((p: any) => p.text?.includes('<state_snapshot>'));
                if (isCompression) {
                    const tempAcpId = [...(manager as any).acpToLogical.keys()].find((key) => (manager as any).acpToLogical.get(key).startsWith('temp-compression'));
                    setTimeout(() => {
                        acpProcess.emit('chunk', {
                            sessionId: tempAcpId,
                            sessionUpdate: 'agent_message_chunk',
                            content: { text: summaryText },
                        });
                        acpProcess.emit('end', { sessionId: tempAcpId });
                    }, 50);
                }
            });
        });

        test('should insert a summary message and preserve all original messages', async () => {
            for (let i = 0; i < 20; i++) {
                manager.addUserMessage(sessionId, [{ type: 'text', text: `message ${i}` }]);
            }
            const originalMessageCount = manager.getSession(sessionId)!.messages.length;

            const result = await manager.compressHistory(sessionId);
            expect(result).toBe(true);

            const session = manager.getSession(sessionId)!;
            expect(session.messages.length).toBe(originalMessageCount + 1);
            const summaryMessage = session.messages.find((m) => m.type === 'history_summary');
            expect(summaryMessage).toBeDefined();
            expect((summaryMessage as any).summary).toBe(summaryText);
        });

        test('_composePrompt should use full history when no summary exists', () => {
            manager.addUserMessage(sessionId, [{ type: 'text', text: 'message 1' }]);
            manager.addUserMessage(sessionId, [{ type: 'text', text: 'message 2' }]);
            const session = (manager as any).sessions.get(sessionId);
            session.isNewProcess = true;

            const promptContent = (manager as any)._composePrompt(sessionId, [{ type: 'text', text: 'current prompt' }]);
            const promptText = promptContent.map((p: any) => p.text).join('');

            expect(promptText).toContain('## User\nmessage 1');
            expect(promptText).toContain('## User\nmessage 2');
            expect(promptText).toContain('current prompt');
        });

        test('_composePrompt should use only history after the last summary', () => {
            manager.addUserMessage(sessionId, [{ type: 'text', text: 'message 1' }]);
            (manager as any).sessions.get(sessionId)!.messages.push({ id: 'summary-1', type: 'history_summary', summary: 'Summary of message 1' });
            manager.addUserMessage(sessionId, [{ type: 'text', text: 'message 2' }]);
            const session = (manager as any).sessions.get(sessionId);
            session.isNewProcess = true;

            const promptContent = (manager as any)._composePrompt(sessionId, [{ type: 'text', text: 'current prompt' }]);
            const promptText = promptContent.map((p: any) => p.text).join('');

            expect(promptText).not.toContain('## User\nmessage 1\n\n');
            expect(promptText).toContain('Summary of message 1');
            expect(promptText).toContain('## User\nmessage 2');
            expect(promptText).toContain('current prompt');
        });

        test('exportSessionToMarkdown should render summary messages', async () => {
            manager.addUserMessage(sessionId, [{ type: 'text', text: 'message 1' }]);
            // Add enough messages to ensure compression will be triggered
            for (let i = 0; i < 15; i++) {
                manager.addUserMessage(sessionId, [{ type: 'text', text: `filler message ${i}` }]);
            }
            await manager.compressHistory(sessionId);
            manager.addUserMessage(sessionId, [{ type: 'text', text: 'message 2' }]);

            const markdown = manager.exportSessionToMarkdown(sessionId);
            expect(markdown).toContain('## User\nmessage 1');
            expect(markdown).toContain('## Compressed History');
            expect(markdown).toContain(summaryText);
            expect(markdown).toContain('## User\nmessage 2');
        });
    });

    describe('branchSession', () => {
        let manager: SessionManager;
        let originalSessionId: string;
        let userMessage: any;
        let agentMessage: any;

        beforeEach(async () => {
            const workspaceManager = new WorkspaceManager();
            manager = new SessionManager(workspaceManager);
            await manager.initialize();

            // Mock the createSession to return different IDs for subsequent calls
            const newSessionMock = vi.spyOn((manager as any).acpProcess, 'newSession');
            newSessionMock.mockResolvedValueOnce({ sessionId: 'original-session-id' });
            newSessionMock.mockResolvedValueOnce({ sessionId: 'new-branch-id' });

            originalSessionId = await manager.createSession('default');

            // Manually add messages to control the history for the test
            const session = (manager as any).sessions.get(originalSessionId);
            userMessage = { id: 'msg-1', type: 'user', content: [{ type: 'text', text: 'Hello' }] };
            agentMessage = { id: 'msg-2', type: 'agent', content: 'Hi there!' };
            session.messages.push(userMessage);
            session.messages.push(agentMessage);
        });

        test('should create a new session with history up to the specified agent message', async () => {
            const session = (manager as any).sessions.get(originalSessionId);
            session.name = 'Original Session'; // Set a name for testing
            const newSession = await manager.branchSession(originalSessionId, agentMessage.id);

            expect(newSession).toBeDefined();
            expect(newSession.id).toBe('new-branch-id');
            expect(newSession.name).toMatch(/^\(Branch @ .*\) Original Session/);
            expect(newSession.messages).toHaveLength(2);
            expect(newSession.messages[0].id).toBe(userMessage.id);
            expect(newSession.messages[1].id).toBe(agentMessage.id);

            // Verify the original session is untouched
            const originalSession = manager.getSession(originalSessionId);
            expect(originalSession?.messages).toHaveLength(2);
        });

        test('should replace the old branch tag when branching from an existing branch', async () => {
            const session = (manager as any).sessions.get(originalSessionId);
            session.name = '(Branch @ 1:23:45 PM) Original Session'; // Set a branched name

            const newSession = await manager.branchSession(originalSessionId, agentMessage.id);

            expect(newSession).toBeDefined();
            expect(newSession.id).toBe('new-branch-id');
            // It should not be nested
            expect(newSession.name).not.toContain('(Branch @ 1:23:45 PM)');
            // It should have the new branch tag and the original base name
            expect(newSession.name).toMatch(/^\(Branch @ .*\) Original Session/);
        });

        test('should throw an error if trying to branch from a non-agent message', async () => {
            await expect(manager.branchSession(originalSessionId, userMessage.id))
                .rejects
                .toThrow('Branching is only supported from agent messages.');
        });

        test('should throw an error if the original session is not found', async () => {
            await expect(manager.branchSession('non-existent-id', agentMessage.id))
                .rejects
                .toThrow('Original session with ID non-existent-id not found.');
        });

        test('should throw an error if the branch message is not found', async () => {
            await expect(manager.branchSession(originalSessionId, 'non-existent-msg-id'))
                .rejects
                .toThrow('Message with ID non-existent-msg-id not found in session original-session-id.');
        });
    });
});
