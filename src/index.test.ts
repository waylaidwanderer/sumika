import { expect, test, describe, beforeEach, afterEach, vi } from 'vitest';
import app, { initializeApp, resetState } from './index';
import { workspaceManager, sessionManager } from './managers';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';

let testHomeDir: string;

beforeEach(async () => {
    testHomeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sumika-index-test-'));

    const oldSessions = sessionManager?.getAllSessions() || [];
    for (const session of oldSessions) {
        sessionManager.deleteSession(session.id);
    }
    await new Promise(resolve => setTimeout(resolve, 100));

    resetState(testHomeDir);
    await initializeApp(testHomeDir);
});

afterEach(async () => {
    if (testHomeDir) {
        await fs.rm(testHomeDir, { recursive: true, force: true });
    }
});

describe('E2E Interactive Flows', () => {
    test('should handle a simple prompt', async () => {
        // 1. Create a session
        const createRequest = new Request('http://localhost/api/sessions', { 
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId: 'default-workspace' }),
        });
        const createResponse = await app.request(createRequest);
        expect(createResponse.status).toBe(200);
        const { id: sessionId } = await createResponse.json();
        expect(sessionId).toBeTypeOf('string');

        // 2. Open the listening stream
        const listenRequest = new Request(`http://localhost/api/sessions/${sessionId}/listen`, { method: 'GET' });
        const listenResponsePromise = app.request(listenRequest);

        // 3. Send a prompt
        const promptRequest = new Request(`http://localhost/api/sessions/${sessionId}/prompt`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                content: [{
                    type: 'text', 
                    text: 'What is the capital of France? Answer purely from your training data and do not use any tools.' 
                }] 
            }),
        });
        const promptResponse = await app.request(promptRequest);
        expect(promptResponse.status).toBe(201);

        // 4. Verify the response arrives on the listening stream
        const listenResponse = await listenResponsePromise;
        const reader = listenResponse.body!.getReader();
        const decoder = new TextDecoder();
        let found = false;
        let endReceived = false;

        const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout waiting for SSE message")),
 25000));
        const reading = (async () => {
            while (!endReceived) {
                const { done, value } = await reader.read();
                if (done) break;
                const chunk = decoder.decode(value);
                const lines = chunk.split('\n').filter(line => line);
                for (const line of lines) {
                    const parsed = JSON.parse(line);
                    if (parsed.type === 'chunk' && parsed.content?.text?.trim()) {
                        found = true;
                    }
                    if (parsed.type === 'end') {
                        endReceived = true;
                        break;
                    }
                }
            }
        })();

        await Promise.race([reading, timeout]);

        expect(found).toBe(true);
        expect(endReceived).toBe(true);

    }, 30000);

    test('should handle a terminal tool call flow', async () => {
        const createResponse = await app.request(new Request('http://localhost/api/sessions', { 
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId: 'default-workspace' }),
        }));
        const { id: sessionId } = await createResponse.json();

        type QueueResolve = (value: string) => void;
        const eventQueue: string[] = [];
        const waiters: QueueResolve[] = [];

        const enqueue = (line: string) => {
            if (waiters.length > 0) {
                const resolve = waiters.shift()!;
                resolve(line);
            } else {
                eventQueue.push(line);
            }
        };

        const nextEvent = () => new Promise<string>((resolve) => {
            if (eventQueue.length > 0) {
                resolve(eventQueue.shift()!);
            } else {
                waiters.push(resolve);
            }
        });

        const mockStream = {
            write(data: string) {
                const lines = data.split('\n').filter(line => line.trim().startsWith('{'));
                for (const line of lines) {
                    enqueue(line);
                }
            },
            onAbort() {
                // no-op for tests
            },
        } as any;

        sessionManager.registerStream(sessionId, mockStream);

        const promptSpy = vi.spyOn(sessionManager, 'prompt').mockImplementation(async () => {
            process.nextTick(() => {
                mockStream.write(
                    JSON.stringify({
                        type: 'permission_request',
                        requestId: 123,
                        toolCall: { toolCallId: 'run_shell_command-1', title: 'Run ls -la' },
                    }) + '\n',
                );

                setTimeout(() => {
                    mockStream.write(
                        JSON.stringify({
                            type: 'chunk',
                            sessionUpdate: 'tool_call_update',
                            toolCallId: 'run_shell_command-1',
                            content: [{ type: 'content', content: { text: '.env.example' } }],
                        }) + '\n',
                    );
                    mockStream.write(JSON.stringify({ type: 'end', stopReason: 'end_turn' }) + '\n');
                }, 50);
            });
        });

        const eventProcessingPromise = (async () => {
            let toolOutput = '';
            let endReceived = false;

            while (!endReceived) {
                const line = await nextEvent();
                const parsed = JSON.parse(line);

                if (parsed.type === 'permission_request') {
                    const permissionResponseRequest = new Request(`http://localhost/api/sessions/${sessionId}/permission`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            requestId: parsed.requestId,
                            outcome: { outcome: 'selected', optionId: 'proceed_once' },
                        }),
                    });
                    const res = await app.request(permissionResponseRequest);
                    expect(res.status).toBe(200);
                } else if (parsed.type === 'chunk' && parsed.sessionUpdate === 'tool_call_update') {
                    if (parsed.content && parsed.content[0].content.text) {
                        toolOutput += parsed.content[0].content.text;
                    }
                } else if (parsed.type === 'end') {
                    endReceived = true;
                }
            }

            return toolOutput;
        })();

        const promptRequest = new Request(`http://localhost/api/sessions/${sessionId}/prompt`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: [{ type: 'text', text: `Run ls -la` }] }),
        });
        try {
            const promptResponse = await app.request(promptRequest);
            expect(promptResponse.status).toBe(201);

            const finalOutput = await eventProcessingPromise;

            expect(finalOutput).toContain('.env.example');
        } finally {
            promptSpy.mockRestore();
        }
    }, 30000);
});

describe('Session CRUD and Export', { timeout: 30000 }, () => {
    test('GET /api/sessions should return a list of sessions for a workspace', async () => {
        // 1. Create a second workspace to ensure we're filtering correctly
        const newWorkspace = await workspaceManager.createWorkspace('Test Workspace 2');

        // 2. Create sessions in different workspaces
        const createReq1 = new Request('http://localhost/api/sessions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId: 'default-workspace' }),
        });
        const createRes1 = await app.request(createReq1);
        const { id: sessionId1 } = await createRes1.json();

        const createReq2 = new Request('http://localhost/api/sessions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId: newWorkspace.id }),
        });
        await app.request(createReq2);

        // 3. Get all sessions for the default workspace
        const getReq = new Request('http://localhost/api/sessions?workspaceId=default-workspace', { method: 'GET' });
        const getRes = await app.request(getReq);
        expect(getRes.status).toBe(200);
        const sessions = await getRes.json();
        expect(Array.isArray(sessions)).toBe(true);
        expect(sessions.length).toBe(1);
        expect(sessions[0].id).toBe(sessionId1);
    });

    test('GET /api/sessions should support pagination', async () => {
        // Create 3 sessions
        for (let i = 0; i < 3; i++) {
            const createReq = new Request('http://localhost/api/sessions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ workspaceId: 'default-workspace' }),
            });
            await app.request(createReq);
        }

        // Test limit
        const limitReq = new Request('http://localhost/api/sessions?workspaceId=default-workspace&limit=2', { method: 'GET' });
        const limitRes = await app.request(limitReq);
        expect(limitRes.status).toBe(200);
        const limitedSessions = await limitRes.json();
        expect(limitedSessions.length).toBe(2);

        // Test offset
        const offsetReq = new Request('http://localhost/api/sessions?workspaceId=default-workspace&limit=2&offset=1', { method: 'GET' });
        const offsetRes = await app.request(offsetReq);
        expect(offsetRes.status).toBe(200);
        const offsetSessions = await offsetRes.json();
        expect(offsetSessions.length).toBe(2);
        
        // Ensure the offset is working correctly by comparing IDs
        const allSessions = sessionManager.getAllSessions({ workspaceId: 'default-workspace' });
        expect(offsetSessions[0].id).toBe(allSessions[1].id);
    });

    test('GET /api/sessions should support summary view', async () => {
        const createReq = new Request('http://localhost/api/sessions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId: 'default-workspace' }),
        });
        const createRes = await app.request(createReq);
        const { id: sessionId } = await createRes.json();
        sessionManager.addUserMessage(sessionId, [{ type: 'text', text: 'test message' }]);

        // Get full view
        const fullReq = new Request(`http://localhost/api/sessions?workspaceId=default-workspace&view=full`, { method: 'GET' });
        const fullRes = await app.request(fullReq);
        const fullSessions = await fullRes.json();
        expect(fullSessions[0].messages).toBeDefined();
        expect(fullSessions[0].messages.length).toBeGreaterThan(0);

        // Get summary view
        const summaryReq = new Request(`http://localhost/api/sessions?workspaceId=default-workspace&view=summary`, { method: 'GET' });
        const summaryRes = await app.request(summaryReq);
        const summarySessions = await summaryRes.json();
        expect(summarySessions[0].messages).toEqual([]);
    });

    test('central process crash marks sessions disconnected (no reinitialize endpoint)', async () => {
        // 1. Create a session
        const createReq = new Request('http://localhost/api/sessions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId: 'default-workspace' }),
        });
        const createRes = await app.request(createReq);
        const { id: sessionId } = await createRes.json();

        // 2. Simulate central process crash
        const proc = (sessionManager as any).acpProcess as any;
        expect(proc).toBeDefined();
        proc.kill?.();

        // Allow a moment for the exit handler to fire
        await new Promise(resolve => setTimeout(resolve, 200));

        const session = sessionManager.getSession(sessionId);
        expect(session?.status).toBe('disconnected');

        // 3. Reinitialize endpoint removed; expect 404
        const reinitReq = new Request(`http://localhost/api/sessions/${sessionId}/reinitialize`, { method: 'POST' });
        const reinitRes = await app.request(reinitReq);
        expect(reinitRes.status).toBe(404);
    });

    test('GET /api/sessions/:sessionId should return a single session', async () => {
        // 1. Create a session
        const createReq = new Request('http://localhost/api/sessions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId: 'default-workspace' }),
        });
        const createRes = await app.request(createReq);
        const { id: sessionId } = await createRes.json();

        // 2. Get the session by ID
        const getReq = new Request(`http://localhost/api/sessions/${sessionId}`, { method: 'GET' });
        const getRes = await app.request(getReq);
        expect(getRes.status).toBe(200);
        const session = await getRes.json();
        expect(session.id).toBe(sessionId);
        expect(session.name).toBe('Untitled Session');
    });

    test('GET /api/sessions/:sessionId should return 404 for a non-existent session', async () => {
        const getReq = new Request('http://localhost/api/sessions/non-existent-id', { method: 'GET' });
        const getRes = await app.request(getReq);
        expect(getRes.status).toBe(404);
    });

    test('PATCH /api/sessions/:sessionId should update a session', async () => {
        // 1. Create a session
        const createReq = new Request('http://localhost/api/sessions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId: 'default-workspace' }),
        });
        const createRes = await app.request(createReq);
        const { id: sessionId } = await createRes.json();

        // 2. Update the session
        const patchReq = new Request(`http://localhost/api/sessions/${sessionId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Updated Name', pinned: true }),
        });
        const patchRes = await app.request(patchReq);
        expect(patchRes.status).toBe(200);
        const updatedSession = await patchRes.json();
        expect(updatedSession.name).toBe('Updated Name');
        expect(updatedSession.pinned).toBe(true);

        // 3. Verify the update
        const getReq = new Request(`http://localhost/api/sessions/${sessionId}`, { method: 'GET' });
        const getRes = await app.request(getReq);
        const session = await getRes.json();
        expect(session.name).toBe('Updated Name');
        expect(session.pinned).toBe(true);
    });

    test('DELETE /api/sessions/:sessionId should delete a session', async () => {
        // 1. Create a session
        const createReq = new Request('http://localhost/api/sessions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId: 'default-workspace' }),
        });
        const createRes = await app.request(createReq);
        const { id: sessionId } = await createRes.json();

        // 2. Delete the session
        const deleteReq = new Request(`http://localhost/api/sessions/${sessionId}`, { method: 'DELETE' });
        const deleteRes = await app.request(deleteReq);
        expect(deleteRes.status).toBe(204);

        // 3. Verify it's gone
        const getReq = new Request(`http://localhost/api/sessions/${sessionId}`, { method: 'GET' });
        const getRes = await app.request(getReq);
        expect(getRes.status).toBe(404);
    });

    test('GET /api/sessions/:sessionId/export should return a markdown file', async () => {
        // 1. Create a session and send a prompt
        const createReq = new Request('http://localhost/api/sessions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId: 'default-workspace' }),
        });
        const createRes = await app.request(createReq);
        const { id: sessionId } = await createRes.json();

        const promptRequest = new Request(`http://localhost/api/sessions/${sessionId}/prompt`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: [{ type: 'text', text: 'Hello' }] }),
        });
        await app.request(promptRequest);

        // Give the session time to process and save
        await new Promise(resolve => setTimeout(resolve, 2000));

        // 2. Export the session
        const exportReq = new Request(`http://localhost/api/sessions/${sessionId}/export`, { method: 'GET' });
        const exportRes = await app.request(exportReq);
        expect(exportRes.status).toBe(200);
        expect(exportRes.headers.get('Content-Type')).toBe('text/markdown');
        expect(exportRes.headers.get('Content-Disposition')).toContain('attachment; filename=');
        
        const markdown = await exportRes.text();
        expect(markdown).toContain('## User\nHello\n\n');
    });

    test('POST /api/sessions/:sessionId/branch should create a new session from a message', async () => {
        // 1. Create a session
        const createReq = new Request('http://localhost/api/sessions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId: 'default-workspace' }),
        });
        const createRes = await app.request(createReq);
        const { id: sessionId } = await createRes.json();

        // 2. Manually add messages to its history for a predictable state
        const session = (sessionManager as any).sessions.get(sessionId);
        const userMessage = { id: 'msg-user-1', type: 'user', content: [{ type: 'text', text: 'First prompt' }] };
        const agentMessage = { id: 'msg-agent-1', type: 'agent', content: 'First response' };
        session.messages.push(userMessage, agentMessage);
        session.name = 'Original Session'; // Give it a name to check the branch name

        // 3. Call the branch endpoint
        const branchReq = new Request(`http://localhost/api/sessions/${sessionId}/branch`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ branchFromMessageId: agentMessage.id }),
        });
        const branchRes = await app.request(branchReq);
        expect(branchRes.status).toBe(201);

        // 4. Verify the new session data in the response
        const newSession = await branchRes.json();
        expect(newSession.id).not.toBe(sessionId);
        expect(newSession.name).toMatch(/^\(Branch @ .*\) Original Session/);
        expect(newSession.messages).toHaveLength(2);
        expect(newSession.messages[1].id).toBe(agentMessage.id);

        // 5. Verify the new session was actually persisted in the manager
        const persistedSession = sessionManager.getSession(newSession.id);
        expect(persistedSession).toBeDefined();
        expect(persistedSession?.name).toBe(newSession.name);
    });
});

describe('Workspace CRUD', { timeout: 10000 }, () => {
    test('should create, list, update, and delete a workspace', async () => {
        // 1. List initial workspaces (should be just the default)
        const listReq1 = new Request('http://localhost/api/workspaces', { method: 'GET' });
        const listRes1 = await app.request(listReq1);
        expect(listRes1.status).toBe(200);
        const initialWorkspaces = await listRes1.json();
        expect(initialWorkspaces.length).toBe(1);
        expect(initialWorkspaces[0].name).toBe('Default Workspace');

        // 2. Create a new workspace
        const createReq = new Request('http://localhost/api/workspaces', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Test Workspace', description: 'A test' }),
        });
        const createRes = await app.request(createReq);
        expect(createRes.status).toBe(201);
        const newWorkspace = await createRes.json();
        expect(newWorkspace.name).toBe('Test Workspace');
        expect(newWorkspace.id).toBe('test-workspace');

        // 3. List workspaces again (should be two now)
        const listReq2 = new Request('http://localhost/api/workspaces', { method: 'GET' });
        const listRes2 = await app.request(listReq2);
        expect(listRes2.status).toBe(200);
        const updatedWorkspaces = await listRes2.json();
        expect(updatedWorkspaces.length).toBe(2);

        // 4. Update the workspace
        const updateReq = new Request(`http://localhost/api/workspaces/${newWorkspace.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Updated Workspace Name' }),
        });
        const updateRes = await app.request(updateReq);
        expect(updateRes.status).toBe(200);
        const updatedWorkspace = await updateRes.json();
        expect(updatedWorkspace.name).toBe('Updated Workspace Name');

        // 5. Delete the workspace
        const deleteReq = new Request(`http://localhost/api/workspaces/${newWorkspace.id}`, { method: 'DELETE' });
        const deleteRes = await app.request(deleteReq);
        expect(deleteRes.status).toBe(204);

        // 6. Verify it's gone
        const getReq = new Request(`http://localhost/api/workspaces/${newWorkspace.id}`, { method: 'GET' });
        const getRes = await app.request(getReq);
        expect(getRes.status).toBe(404);
    });

    test('should update a workspace with environment variables', async () => {
        // 1. Create a new workspace
        const createRes = await app.request(new Request('http://localhost/api/workspaces', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Env Test Workspace' }),
        }));
        const newWorkspace = await createRes.json();

        // 2. Update the workspace with env vars
        const updates = {
            name: 'Updated Env Workspace',
            env: { 'API_KEY': '12345', 'NODE_ENV': 'test' },
        };
        const updateReq = new Request(`http://localhost/api/workspaces/${newWorkspace.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(updates),
        });
        const updateRes = await app.request(updateReq);
        expect(updateRes.status).toBe(200);
        const updatedWorkspace = await updateRes.json();

        // 3. Verify the response
        expect(updatedWorkspace.name).toBe('Updated Env Workspace');
        expect(updatedWorkspace.env).toEqual({ 'API_KEY': '12345', 'NODE_ENV': 'test' });

        // 4. Verify the data was persisted in the manager
        const persistedWorkspace = workspaceManager.getWorkspace(newWorkspace.id);
        expect(persistedWorkspace?.env).toEqual({ 'API_KEY': '12345', 'NODE_ENV': 'test' });
    });
});