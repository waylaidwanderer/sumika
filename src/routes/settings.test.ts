import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import app, { initializeApp, resetState } from '../index';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';

let testHomeDir: string;

describe('Settings API', () => {
  beforeEach(async () => {
    testHomeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sumika-settings-routes-'));
    resetState(testHomeDir);
    await initializeApp(testHomeDir);
  });

  afterEach(async () => {
    if (testHomeDir) {
      await fs.rm(testHomeDir, { recursive: true, force: true });
    }
  });

  test('GET /api/settings returns defaults when missing', async () => {
    const req = new Request('http://localhost/api/settings');
    const res = await app.request(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ env: {}, mcpServers: {} });
  });

  test('PUT /api/settings validates and persists', async () => {
    const payload = {
      env: {},
      mcpServers: {
        'node-server': { command: 'node', args: ['server.js'], env: { PORT: '3000' } },
      },
    };
    const putReq = new Request('http://localhost/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const putRes = await app.request(putReq);
    expect(putRes.status).toBe(200);
    const after = await putRes.json();
    expect(after).toEqual(payload);

    const getRes = await app.request(new Request('http://localhost/api/settings'));
    expect(getRes.status).toBe(200);
    const roundtrip = await getRes.json();
    expect(roundtrip).toEqual(payload);
  });
});
