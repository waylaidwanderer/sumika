import { spawn, ChildProcess } from 'child_process';
import * as dotenv from 'dotenv';
import { EOL } from 'os';
import { EventEmitter } from 'events';
import { promises as fs } from 'fs';
import * as path from 'path';
import { logger } from './logger';

dotenv.config();

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: any;
  error?: any;
}
interface JsonRpcRequest {
  jsonrpc: '2.0';
  method: string;
  params?: any;
  id?: number;
}
interface PromptParams {
  prompt: any[];
}

export class AcpProcess extends EventEmitter {
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

    this.process.stdout!.on('data', (data) => {
      this.messageBuffer += data.toString();
      const messages = this.messageBuffer.split(EOL);
      this.messageBuffer = messages.pop() || '';
      for (const message of messages) {
        if (message) {
          try {
            this.handleMessage(JSON.parse(message));
          } catch (e) {
            logger.warn(`Failed to parse message from agent: ${message}`);
          }
        }
      }
    });

    this.process.stderr!.on('data', (data) => {
      const message = data.toString();
      if (message.includes('MCP ERROR') && (message.includes('TypeError: terminated') || message.includes('fetch failed'))) {
        logger.debug(`acp stderr: ${message}`);
      } else if (message.includes('MCP ERROR')) {
        logger.warn(`acp stderr: ${message}`);
      } else {
        logger.error(`acp stderr: ${message}`);
      }
    });

    this.process.on('exit', (code) => {
      if (code !== 0) {
        logger.error(`acp process exited with code ${code}`);
      }
      options.onExit(code);
    });
  }

  private handleMessage(message: any) {
    if (message.method) {
      if (message.method === 'session/update') {
        logger.debug({ message }, 'Received session update');
        this.emit('chunk', { sessionId: message.params.sessionId, ...message.params.update });
      } else if (message.method === 'session/request_permission' && typeof message.id === 'number') {
        logger.debug({ message }, 'Received permission request');
        this.emit('permission_request', { sessionId: message.params.sessionId, requestId: message.id, ...message.params });
      } else if (message.method === 'fs/read_text_file' && typeof message.id === 'number') {
        logger.debug({ message }, 'Received read file request');
        this.handleReadFile(message.id, message.params.path);
      } else if (message.method === 'fs/write_text_file' && typeof message.id === 'number') {
        logger.debug({ message }, 'Received write file request');
        this.handleWriteFile(message.id, message.params.path, message.params.content);
      } else {
        logger.warn({ message }, 'Unhandled message with method from acp process');
      }
    } else if (message.id && this.responseCallbacks.has(message.id)) {
      logger.debug({ message }, 'Received message');
      if (message.error) {
        const sid = this.requestSessionMap.get(message.id);
        this.emit('error', sid ? { sessionId: sid, ...message } : message);
      }
      const callback = this.responseCallbacks.get(message.id)!;
      if (message.result && message.result.stopReason) {
        const sessionId = message.result.sessionId || this.requestSessionMap.get(message.id);
        this.emit('end', { sessionId, type: 'end', ...message.result });
        logger.debug({ result: message.result }, 'Emitted end event');
      }
      callback(message);
      this.responseCallbacks.delete(message.id);
    } else {
      logger.warn({ message }, 'Unhandled message from gemini process');
    }
  }

  private async handleWriteFile(id: number, filePath: string, content: string) {
    try {
      logger.debug({ filePath }, 'Writing file');
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, content, 'utf-8');
      const response = {
        jsonrpc: '2.0',
        id,
        result: {},
      };
      this.process.stdin!.write(JSON.stringify(response) + EOL);
      logger.debug({ id }, 'Write file response sent');
    } catch (error: any) {
      const message = `a system error occurred: [${error.code || 'UNKNOWN'}] ${error.message || 'An unknown error occurred.'}`;
      const response = {
        jsonrpc: '2.0',
        id,
        error: message,
      };
      this.process.stdin!.write(JSON.stringify(response) + EOL);
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
      this.process.stdin!.write(JSON.stringify(response) + EOL);
      logger.debug({ id }, 'Read file response sent');
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        logger.debug({ id }, `File not found, returning empty content`);
        const response = {
          jsonrpc: '2.0',
          id,
          result: { content: '' },
        };
        this.process.stdin!.write(JSON.stringify(response) + EOL);
        return;
      }

      const message = `a system error occurred: [${error.code || 'UNKNOWN'}] ${error.message || 'An unknown error occurred.'}`;
      const response = {
        jsonrpc: '2.0',
        id,
        error: message,
      };
      this.process.stdin!.write(JSON.stringify(response) + EOL);
      logger.debug({ id, error: response.error }, 'Read file error response sent');
    }
  }

  private sendRequest(method: string, params: any, meta?: { sessionId?: string }): Promise<JsonRpcResponse> {
    const id = this.requestId++;
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      method,
      params,
      id,
    };
    const jsonString = JSON.stringify(request);
    this.process.stdin!.write(jsonString + EOL);

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

  public sendPermissionResponse(requestId: number, outcome: any) {
    const response = {
      jsonrpc: '2.0',
      id: requestId,
      result: { outcome }
    };
    const jsonString = JSON.stringify(response);
    this.process.stdin!.write(jsonString + EOL);
    logger.debug({ requestId }, 'Sent permission response');
  }

  async connect(): Promise<any> {
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
      if (response.error.code === -32000) {
        await this.authenticate();
        return this.connect();
      }
      throw new Error(`Initialize error: ${JSON.stringify(response.error)}`);
    }
    return response.result;
  }

  private async authenticate(): Promise<any> {
    const response = await this.sendRequest('authenticate', {
      methodId: 'api_key'
    });
    if (response.error) {
      throw new Error(`Authentication error: ${JSON.stringify(response.error)}`);
    }
    return response.result;
  }

  public async newSession(params: { cwd: string; mcpServers: any[] }): Promise<any> {
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

  cancel(sessionId: string) {
    const notification = {
      jsonrpc: '2.0',
      method: 'session/cancel',
      params: { sessionId },
    };
    this.process.stdin!.write(JSON.stringify(notification) + EOL);
    logger.debug({ sessionId }, 'Sent cancel notification');
  }

  public kill() {
    this.process.kill();
  }
}