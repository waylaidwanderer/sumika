import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { SessionManager } from './session';
import { WorkspaceManager } from './workspaces';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';

vi.mock('./acp', () => {
  const AcpProcess = vi.fn().mockImplementation(() => {
    return {
      connect: vi.fn().mockResolvedValue(undefined),
      newSession: vi.fn().mockResolvedValue({ sessionId: 'mock-session-id' }),
      on: vi.fn(),
      kill: vi.fn(),
    } as any;
  });
  return { AcpProcess };
});

let baseDir: string;

describe('SessionManager MCP merge', () => {
  beforeEach(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sumika-session-merge-'));
  });

  afterEach(async () => {
    if (baseDir) await fs.rm(baseDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  test('merges global and workspace MCP (workspace overrides)', async () => {
        baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sumika-session-merge-'));
        const wm = new WorkspaceManager(baseDir);
        await wm.initialize();
        const workspace = await wm.createWorkspace('test-workspace');

        // Setup global settings
        const sumikaDir = wm.sumikaDir;
        await fs.mkdir(sumikaDir, { recursive: true });
        await fs.writeFile(
            path.join(sumikaDir, 'settings.json'),
      JSON.stringify({
        mcpServers: {
          'global-only': { command: 'go', args: ['run', 'tool.go'], env: { VERBOSE: '1' } },
          shared: { command: 'python', args: ['-m', 'global_shared'], env: {} },
        },
      }),
      'utf-8',
    );

    const ws = await wm.createWorkspace('Merge Test');
    await wm.updateWorkspace(ws.id, {
      mcpServers: {
        'ws-only': { command: 'node', args: ['ws.js'], env: { PORT: '8080' } },
        shared: { command: 'python', args: ['-m', 'workspace_shared'], env: { WS: '1' } },
      },
    });

    const sm = new SessionManager(wm);
    await sm.initialize();
    const sessionId = await sm.createSession(ws.id);
    expect(sessionId).toBe('mock-session-id');

    const { AcpProcess } = await import('./acp');
    const mockCtor: any = AcpProcess as any;
    const instance = mockCtor.mock.results[0].value; // first instance
    const newSessionCalls = instance.newSession.mock.calls;
    expect(newSessionCalls.length).toBeGreaterThan(0);
    const mcpArg = newSessionCalls[0][0].mcpServers;

    const byName = (a: any, b: any) => a.name.localeCompare(b.name);
    mcpArg.sort(byName);

    const expected = [
      {
        name: 'global-only',
        command: 'go',
        args: ['run', 'tool.go'],
        env: [{ name: 'VERBOSE', value: '1' }],
      },
      {
        name: 'shared',
        command: 'python',
        args: ['-m', 'workspace_shared'],
        env: [{ name: 'WS', value: '1' }],
      },
      {
        name: 'ws-only',
        command: 'node',
        args: ['ws.js'],
        env: [{ name: 'PORT', value: '8080' }],
      },
    ];

    expected.forEach(e => e.env.sort((a, b) => a.name.localeCompare(b.name)));
    mcpArg.forEach((t: any) => t.env.sort((a: any, b: any) => a.name.localeCompare(b.name)));
    expect(mcpArg).toEqual(expected);
  });
});
