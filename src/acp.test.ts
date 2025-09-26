import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import { EOL, tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    afterEach, beforeEach,
    expect, test, vi,
} from 'vitest';

import AcpProcess from './acp';

let acpProcess: AcpProcess;
let testDir: string;

beforeEach(async () => {
    const tempDirPrefix = join(tmpdir(), 'acp-test-');
    testDir = await fs.mkdtemp(tempDirPrefix);
    acpProcess = new AcpProcess({ onExit: (_code: number | null) => {} });
});

afterEach(async () => {
    if (acpProcess) {
        acpProcess.kill();
    }
    if (testDir) {
        await fs.rm(testDir, { recursive: true, force: true });
    }
});

test('should be an event emitter', () => {
    expect(acpProcess).toBeInstanceOf(EventEmitter);
});

test('should emit a permission_request event for a tool call', async () => {
    const mockToolCallRequest = {
        jsonrpc: '2.0' as const,
        method: 'session/request_permission',
        id: 123,
        params: {
            sessionId: 'mock-session-id',
            toolCall: { toolCallId: 'tool-call-abc', title: 'Read file' },
        },
    };
    const permissionPromise = new Promise((resolve) => {
        acpProcess.on('permission_request', (request: { toolCall: unknown; requestId: unknown }) => {
            expect(request.toolCall).toEqual(mockToolCallRequest.params.toolCall);
            expect(request.requestId).toBe(mockToolCallRequest.id);
            resolve(request);
        });
    });
    // eslint-disable-next-line @typescript-eslint/dot-notation
    acpProcess['handleMessage'](mockToolCallRequest);
    await permissionPromise;
});

test('should handle fs/read_text_file and send back content', async () => {
    const filePath = join(__dirname, 'test-file.txt');
    const fileContent = 'hello world';
    // eslint-disable-next-line @typescript-eslint/dot-notation
    const { stdin } = acpProcess['process'];
    if (!stdin) {
        throw new Error('stdin is null');
    }
    const writeSpy = vi.spyOn(stdin, 'write');

    const mockReadFileRequest = {
        jsonrpc: '2.0' as const,
        method: 'fs/read_text_file',
        id: 456,
        params: {
            path: filePath,
        },
    };

    // eslint-disable-next-line @typescript-eslint/dot-notation
    acpProcess['handleMessage'](mockReadFileRequest);

    await new Promise((resolve) => {
        setTimeout(resolve, 100);
    });

    const expectedResponse = {
        jsonrpc: '2.0',
        id: 456,
        result: { content: fileContent },
    };

    expect(writeSpy).toHaveBeenCalledWith(JSON.stringify(expectedResponse) + EOL);

    await fs.unlink(filePath);
});

test('should handle fs/write_text_file and send back success', async () => {
    const filePath = join(__dirname, 'test-write-file.txt');
    const fileContent = 'hello from write file';

    // eslint-disable-next-line @typescript-eslint/dot-notation
    const { stdin } = acpProcess['process'];
    if (!stdin) {
        throw new Error('stdin is null');
    }
    const writeSpy = vi.spyOn(stdin, 'write');

    const mockWriteFileRequest = {
        jsonrpc: '2.0' as const,
        method: 'fs/write_text_file',
        id: 789,
        params: {
            path: filePath,
            content: fileContent,
        },
    };

    // eslint-disable-next-line @typescript-eslint/dot-notation
    acpProcess['handleMessage'](mockWriteFileRequest);

    await new Promise((resolve) => {
        setTimeout(resolve, 100);
    });

    const expectedResponse = {
        jsonrpc: '2.0',
        id: 789,
        result: {},
    };

    expect(writeSpy).toHaveBeenCalledWith(JSON.stringify(expectedResponse) + EOL);

    const writtenContent = await fs.readFile(filePath, 'utf-8');
    expect(writtenContent).toBe(fileContent);

    await fs.unlink(filePath);
});
