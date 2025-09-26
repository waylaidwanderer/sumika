import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import { EOL } from 'node:os';
import { dirname } from 'node:path';

import { config } from 'dotenv';

import logger from './logger';

import type { ChildProcess } from 'node:child_process';

import type { PromptContent } from '@waylaidwanderer/sumika-types';

config();

interface RpcBase {
    jsonrpc: '2.0';
}
interface JsonRpcResponse extends RpcBase {
    id: number;
    result?: unknown;
    error?: unknown;
}
interface JsonRpcRequest extends RpcBase {
    method: string;
    params?: unknown;
    id?: number;
}
interface PromptParams {
    prompt: PromptContent[];
}

type RpcMessage = JsonRpcResponse | JsonRpcRequest;

export default class AcpProcess extends EventEmitter {
    private process: ChildProcess;

    private responseCallbacks = new Map<number, (response: JsonRpcResponse) => void>();

    private requestId = 1;

    private messageBuffer = '';

    private requestSessionMap = new Map<number, string>();

    constructor(options: {
        onExit: (code: number | null) => void;
        customEnv?: Record<string, string>;
        customAcpCommand?: string;
    }) {
        super();

        const env = {
            ...process.env,
            ...options.customEnv,
        };

        if (options.customAcpCommand) {
            logger.info(`Spawning custom ACP agent: ${options.customAcpCommand}`);
            this.process = spawn(options.customAcpCommand, {
                stdio: ['pipe', 'pipe', 'pipe'],
                shell: true,
                env,
            });
        } else {
            const agentScriptPath = require.resolve('@google/gemini-cli/dist/index.js');
            this.process = spawn(process.execPath, [agentScriptPath, '--experimental-acp'], {
                stdio: ['pipe', 'pipe', 'pipe'],
                env,
            });
        }

        if (this.process.stdout) {
            this.process.stdout.on('data', (data) => {
                this.messageBuffer += data.toString();
                const messages = this.messageBuffer.split(EOL);
                this.messageBuffer = messages.pop() ?? '';
                messages.forEach((message) => {
                    if (message) {
                        try {
                            this.handleMessage(JSON.parse(message) as RpcMessage);
                        } catch (_e) {
                            logger.warn(`Failed to parse message from agent: ${message}`);
                        }
                    }
                });
            });
        }

        if (this.process.stderr) {
            this.process.stderr.on('data', (data) => {
                const message = data.toString();
                if (message.includes('MCP ERROR') && (message.includes('TypeError: terminated') || message.includes('fetch failed'))) {
                    logger.debug(`acp stderr: ${message}`);
                } else if (message.includes('MCP ERROR')) {
                    logger.warn(`acp stderr: ${message}`);
                } else {
                    logger.error(`acp stderr: ${message}`);
                }
            });
        }

        this.process.on('exit', (code) => {
            if (code !== 0) {
                logger.error(`acp process exited with code ${code}`);
            }
            options.onExit(code);
        });
    }

    private handleMessage(message: RpcMessage) {
        if ('method' in message) {
            const params = message.params as Record<string, unknown>;
            if (message.method === 'session/update') {
                logger.debug({ message }, 'Received session update');
                this.emit('chunk', { sessionId: params.sessionId, ...params.update as Record<string, unknown> });
            } else if (message.method === 'session/request_permission' && typeof message.id === 'number') {
                logger.debug({ message }, 'Received permission request');
                this.emit('permission_request', { sessionId: params.sessionId, requestId: message.id, ...params });
            } else if (message.method === 'fs/read_text_file' && typeof message.id === 'number') {
                logger.debug({ message }, 'Received read file request');
                this.handleReadFile(message.id, params.path as string);
            } else if (message.method === 'fs/write_text_file' && typeof message.id === 'number') {
                logger.debug({ message }, 'Received write file request');
                this.handleWriteFile(message.id, params.path as string, params.content as string);
            } else {
                logger.warn({ message }, 'Unhandled message with method from acp process');
            }
        } else if (message.id && this.responseCallbacks.has(message.id)) {
            logger.debug({ message }, 'Received message');
            if (message.error) {
                const sid = this.requestSessionMap.get(message.id);
                this.emit('error', sid ? { sessionId: sid, ...message } : message);
            }
            const callback = this.responseCallbacks.get(message.id);
            if (callback) {
                const result = message.result as Record<string, unknown> | undefined;
                if (result?.stopReason) {
                    const sessionId = (result.sessionId as string | undefined)
                        ?? this.requestSessionMap.get(message.id);
                    this.emit('end', { sessionId, type: 'end', ...result });
                    logger.debug({ result }, 'Emitted end event');
                }
                callback(message);
                this.responseCallbacks.delete(message.id);
            }
        } else {
            logger.warn({ message }, 'Unhandled message from gemini process');
        }
    }

    private async handleWriteFile(id: number, filePath: string, content: string) {
        try {
            logger.debug({ filePath }, 'Writing file');
            await fs.mkdir(dirname(filePath), { recursive: true });
            await fs.writeFile(filePath, content, 'utf-8');
            const response = {
                jsonrpc: '2.0',
                id,
                result: {},
            };
            if (this.process.stdin) {
                this.process.stdin.write(JSON.stringify(response) + EOL);
            }
            logger.debug({ id }, 'Write file response sent');
        } catch (error: unknown) {
            const err = error as { code?: string; message?: string };
            const message = `a system error occurred: [${
                err.code ?? 'UNKNOWN'
            }] ${err.message ?? 'An unknown error occurred.'}`;
            const response = {
                jsonrpc: '2.0',
                id,
                error: message,
            };
            if (this.process.stdin) {
                this.process.stdin.write(JSON.stringify(response) + EOL);
            }
            logger.debug({ id, error: response.error }, 'Write file error response sent');
        }
    }

    private async handleReadFile(id: number, filePath: string) {
        logger.debug({ filePath }, 'Reading file');
        try {
            const content = await fs.readFile(filePath, 'utf-8');
            const response = {
                jsonrpc: '2.0',
                id,
                result: { content },
            };
            if (this.process.stdin) {
                this.process.stdin.write(JSON.stringify(response) + EOL);
            }
            logger.debug({ id }, 'Read file response sent');
        } catch (error: unknown) {
            const err = error as { code?: string; message?: string };
            if (err.code === 'ENOENT') {
                logger.debug({ id }, 'File not found, returning empty content');
                const response = {
                    jsonrpc: '2.0',
                    id,
                    result: { content: '' },
                };
                if (this.process.stdin) {
                    this.process.stdin.write(JSON.stringify(response) + EOL);
                }
                return;
            }

            const message = `a system error occurred: [${
                err.code ?? 'UNKNOWN'
            }] ${err.message ?? 'An unknown error occurred.'}`;
            const response = {
                jsonrpc: '2.0',
                id,
                error: message,
            };
            if (this.process.stdin) {
                this.process.stdin.write(JSON.stringify(response) + EOL);
            }
            logger.debug({ id, error: response.error }, 'Read file error response sent');
        }
    }

    private async sendRequest(
        method: string,
        params: unknown,
        meta?: { sessionId?: string },
    ): Promise<JsonRpcResponse> {
        const id = this.requestId;
        this.requestId += 1;
        const request: JsonRpcRequest = {
            jsonrpc: '2.0',
            method,
            params,
            id,
        };
        const jsonString = JSON.stringify(request);
        if (this.process.stdin) {
            this.process.stdin.write(jsonString + EOL);
        }

        if (meta?.sessionId) {
            this.requestSessionMap.set(id, meta.sessionId);
        }

        return new Promise((resolve) => {
            this.responseCallbacks.set(id, (response) => {
                resolve(response);
                this.requestSessionMap.delete(id);
            });
        });
    }

    public sendPermissionResponse(requestId: number, outcome: unknown): void {
        const response = {
            jsonrpc: '2.0',
            id: requestId,
            result: { outcome },
        };
        const jsonString = JSON.stringify(response);
        if (this.process.stdin) {
            this.process.stdin.write(jsonString + EOL);
        }
        logger.debug({ requestId }, 'Sent permission response');
    }

    async connect(): Promise<unknown> {
        const response = await this.sendRequest('initialize', {
            protocolVersion: 1,
            clientCapabilities: {
                fs: {
                    readTextFile: true,
                    writeTextFile: true,
                },
                // terminal: true,
            },
        });

        if (response.error) {
            const error = response.error as { code?: number };
            if (error.code === -32000) {
                await this.authenticate();
                return this.connect();
            }
            throw new Error(`Initialize error: ${JSON.stringify(response.error)}`);
        }
        return response.result;
    }

    private async authenticate(): Promise<unknown> {
        const response = await this.sendRequest('authenticate', {
            methodId: 'api_key',
        });
        if (response.error) {
            throw new Error(`Authentication error: ${JSON.stringify(response.error)}`);
        }
        return response.result;
    }

    public async newSession(params: { cwd: string; mcpServers: unknown[] }): Promise<unknown> {
        const response = await this.sendRequest('session/new', params);
        if (response.error) {
            throw new Error(`New session error: ${JSON.stringify(response.error)}`);
        }
        return response.result;
    }

    async prompt(sessionId: string, params: PromptParams): Promise<JsonRpcResponse> {
        return this.sendRequest('session/prompt', {
            sessionId,
            prompt: params.prompt,
        }, { sessionId });
    }

    cancel(sessionId: string): void {
        const notification = {
            jsonrpc: '2.0',
            method: 'session/cancel',
            params: { sessionId },
        };
        if (this.process.stdin) {
            this.process.stdin.write(JSON.stringify(notification) + EOL);
        }
        logger.debug({ sessionId }, 'Sent cancel notification');
    }

    public kill(): void {
        this.process.kill();
    }
}
