import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    afterEach,
    beforeEach,
    describe, expect, test,
} from 'vitest';

import { loadSettings, saveSettings } from './settings';

let tmpDir: string;
let sumikaDir: string;

describe('settings.ts', () => {
    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(join(tmpdir(), 'sumika-settings-test-'));
        sumikaDir = join(tmpDir, '.sumika');
    });

    afterEach(async () => {
        if (tmpDir) {
            await fs.rm(tmpDir, { recursive: true, force: true });
        }
    });

    test('loadSettings returns default when file is missing', async () => {
        const settings = await loadSettings(sumikaDir);
        expect(settings).toEqual({ env: {}, mcpServers: {} });
    });

    test('loadSettings backs up corrupt file and returns default', async () => {
        await fs.mkdir(sumikaDir, { recursive: true });
        const filePath = join(sumikaDir, 'settings.json');
        await fs.writeFile(filePath, '{ invalid json', 'utf-8');
        const settings = await loadSettings(sumikaDir);
        expect(settings).toEqual({ env: {}, mcpServers: {} });
        const backupExists = await fs
            .stat(`${filePath}.bak`)
            .then(() => true)
            .catch(() => false);
        expect(backupExists).toBe(true);
    });

    test('saveSettings writes file atomically and loadSettings round-trips', async () => {
        const payload = {
            env: {},
            mcpServers: {
                'python-tool': { command: 'python', args: ['-m', 'tool'], env: { PYTHONUNBUFFERED: '1' } },
            },
        };
        await saveSettings(sumikaDir, payload);
        const loaded = await loadSettings(sumikaDir);
        expect(loaded).toEqual(payload);
        const tmpExists = await fs
            .stat(join(sumikaDir, 'settings.json.tmp'))
            .then(() => true)
            .catch(() => false);
        expect(tmpExists).toBe(false);
    });
});
