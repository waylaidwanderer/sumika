import { expect, test, afterEach, beforeEach, vi } from 'vitest';
import { AcpProcess } from './acp';
import { EventEmitter } from 'events';
import { promises as fs } from 'fs';
import * as path from 'path';
import { EOL } from 'os';
import * as os from 'os';

let acpProcess: AcpProcess;
let testDir: string;

beforeEach(async () => {
    const tempDirPrefix = path.join(os.tmpdir(), 'acp-test-');
    testDir = await fs.mkdtemp(tempDirPrefix);
    acpProcess = new AcpProcess({ onExit: (code) => {} });
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
        jsonrpc: '2.0',
        method: 'session/request_permission',
        id: 123,
        params: {
            sessionId: 'mock-session-id',
            toolCall: { toolCallId: 'tool-call-abc', title: 'Read file' }
        }
    };
    const permissionPromise = new Promise(resolve => {
        acpProcess.on('permission_request', (request) => {
            expect(request.toolCall).toEqual(mockToolCallRequest.params.toolCall);
            expect(request.requestId).toBe(mockToolCallRequest.id);
            resolve(request);
        });
    });
    (acpProcess as any).handleMessage(mockToolCallRequest);
    await permissionPromise;
});

test('should handle fs/read_text_file and send back content', async () => {
    const filePath = path.join(__dirname, 'test-file.txt');
    const fileContent = 'hello world';
    await fs.writeFile(filePath, fileContent);

    const writeSpy = vi.spyOn((acpProcess as any).process.stdin, 'write');

    const mockReadFileRequest = {
        jsonrpc: '2.0',
        method: 'fs/read_text_file',
        id: 456,
        params: {
            path: filePath,
        }
    };

    (acpProcess as any).handleMessage(mockReadFileRequest);

    // Need to wait for the async file read to complete
    await new Promise(resolve => setTimeout(resolve, 100));

    const expectedResponse = {
        jsonrpc: '2.0',
        id: 456,
        result: { content: fileContent },
    };

    expect(writeSpy).toHaveBeenCalledWith(JSON.stringify(expectedResponse) + EOL);

    await fs.unlink(filePath);
});

test('should handle fs/write_text_file and send back success', async () => {
    const filePath = path.join(__dirname, 'test-write-file.txt');
    const fileContent = 'hello from write file';

    const writeSpy = vi.spyOn((acpProcess as any).process.stdin, 'write');

    const mockWriteFileRequest = {
        jsonrpc: '2.0',
        method: 'fs/write_text_file',
        id: 789,
        params: {
            path: filePath,
            content: fileContent,
        }
    };

    (acpProcess as any).handleMessage(mockWriteFileRequest);

    // Need to wait for the async file write to complete
    await new Promise(resolve => setTimeout(resolve, 100));

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
