import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    afterEach,
    beforeEach,
    describe,
    expect, test,
} from 'vitest';

import app, { initializeApp, resetState } from '..';
import { getWorkspaceManager } from '../managers';

import type { Workspace } from '@waylaidwanderer/sumika-types';

let testHomeDir: string;

describe('Workspace API', () => {
    let testWorkspace: Workspace;

    beforeEach(async () => {
        testHomeDir = await fs.mkdtemp(join(tmpdir(), 'sumika-w-routes-test-'));
        resetState(testHomeDir);
        await initializeApp(testHomeDir);
        testWorkspace = await getWorkspaceManager().createWorkspace('Test Workspace');
    });

    afterEach(async () => {
        if (testHomeDir) {
            await fs.rm(testHomeDir, { recursive: true, force: true });
        }
    });

    describe('PUT /{workspaceId}', () => {
        test('should update a workspace with valid mcpServers', async () => {
            const updates = {
                name: 'Updated Workspace Name',
                mcpServers: {
                    'my-tool': {
                        command: 'python',
                        args: ['-m', 'my_tool_server'],
                        env: { PYTHONUNBUFFERED: '1' },
                    },
                },
            };

            const req = new Request(`http://localhost/api/workspaces/${testWorkspace.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(updates),
            });

            const res = await app.request(req);
            expect(res.status).toBe(200);
            const json = await res.json();
            expect(json.name).toBe('Updated Workspace Name');
            expect(json.mcpServers).toEqual(updates.mcpServers);

            const updatedWorkspace = getWorkspaceManager().getWorkspace(testWorkspace.id);
            expect(updatedWorkspace?.mcpServers).toEqual(updates.mcpServers);
        });

        test('should return 400 for an invalid mcpServers configuration', async () => {
            const updates = {
                mcpServers: {
                    'bad-tool': {
                        // command is missing, which is required
                        args: ['-m', 'my_tool_server'],
                    },
                },
            };

            const req = new Request(`http://localhost/api/workspaces/${testWorkspace.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(updates),
            });

            const res = await app.request(req);
            expect(res.status).toBe(400);
        });
    });
});

describe('Workspace File Upload API', () => {
    let testWorkspace: Workspace;
    const testFileName = 'test-file.txt';
    const testFileContent = 'hello world';

    beforeEach(async () => {
        testHomeDir = await fs.mkdtemp(join(tmpdir(), 'sumika-w-routes-test-'));
        resetState(testHomeDir);
        await initializeApp(testHomeDir);
        testWorkspace = await getWorkspaceManager().createWorkspace('Test Workspace');
        await fs.writeFile(join(testWorkspace.path, testFileName), testFileContent);
    });

    afterEach(async () => {
        if (testHomeDir) {
            await fs.rm(testHomeDir, { recursive: true, force: true });
        }
    });

    test('GET /files/exists should return true for an existing file', async () => {
        const req = new Request(`http://localhost/api/workspaces/${testWorkspace.id}/files/exists?filename=${testFileName}`);
        const res = await app.request(req);
        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.exists).toBe(true);
    });

    test('GET /files/exists should return false for a non-existent file', async () => {
        const req = new Request(`http://localhost/api/workspaces/${testWorkspace.id}/files/exists?filename=non-existent-file.txt`);
        const res = await app.request(req);
        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.exists).toBe(false);
    });

    test('POST /upload should fail with 409 if file exists and overwrite is false', async () => {
        const formData = new FormData();
        formData.append('file', new File([testFileContent], testFileName));
        const req = new Request(`http://localhost/api/workspaces/${testWorkspace.id}/upload`, {
            method: 'POST',
            body: formData,
        });
        const res = await app.request(req);
        expect(res.status).toBe(409);
    });

    test('POST /upload should succeed if file exists and overwrite is true', async () => {
        const newContent = 'new content';
        const formData = new FormData();
        formData.append('file', new File([newContent], testFileName));
        const req = new Request(`http://localhost/api/workspaces/${testWorkspace.id}/upload?overwrite=true`, {
            method: 'POST',
            body: formData,
        });
        const res = await app.request(req);
        expect(res.status).toBe(201);
        const finalContent = await fs.readFile(join(testWorkspace.path, testFileName), 'utf-8');
        expect(finalContent).toBe(newContent);
    });

    test('POST /upload should succeed for a new file', async () => {
        const newFileName = 'new-file.txt';
        const formData = new FormData();
        formData.append('file', new File(['new'], newFileName));
        const req = new Request(`http://localhost/api/workspaces/${testWorkspace.id}/upload`, {
            method: 'POST',
            body: formData,
        });
        const res = await app.request(req);
        expect(res.status).toBe(201);
        const files = await fs.readdir(testWorkspace.path);
        expect(files).toContain(newFileName);
    });

    test('POST /upload should fail with 413 for a file that is too large', async () => {
        const largeContent = new Uint8Array(101 * 1024 * 1024); // 101MB
        const formData = new FormData();
        formData.append('file', new File([largeContent], 'large-file.bin'));
        const req = new Request(`http://localhost/api/workspaces/${testWorkspace.id}/upload`, {
            method: 'POST',
            body: formData,
        });
        const res = await app.request(req);
        expect(res.status).toBe(413);
    });
});

describe('Workspace File Search API', () => {
    let testWorkspace: Workspace;

    beforeEach(async () => {
        testHomeDir = await fs.mkdtemp(join(tmpdir(), 'sumika-w-search-routes-test-'));
        resetState(testHomeDir);
        await initializeApp(testHomeDir);
        testWorkspace = await getWorkspaceManager().createWorkspace('Search Test Workspace');
    });

    afterEach(async () => {
        if (testHomeDir) {
            await fs.rm(testHomeDir, { recursive: true, force: true });
        }
    });

    test('should respect .gitignore rules', async () => {
    // 1. Setup the workspace with an ignored directory and files
        const gitignoreContent = 'ignored_dir/';
        await fs.writeFile(join(testWorkspace.path, '.gitignore'), gitignoreContent);

        const ignoredDir = join(testWorkspace.path, 'ignored_dir');
        await fs.mkdir(ignoredDir);
        await fs.writeFile(join(ignoredDir, 'ignored-file.txt'), 'should not be found');
        await fs.writeFile(join(testWorkspace.path, 'visible-file.txt'), 'should be found');

        // 2. Search for the ignored file
        const ignoredReq = new Request(`http://localhost/api/workspaces/${testWorkspace.id}/files/search?query=ignored-file`);
        const ignoredRes = await app.request(ignoredReq);
        expect(ignoredRes.status).toBe(200);
        const ignoredJson = await ignoredRes.json();
        expect(ignoredJson).toEqual([]);

        // 3. Search for the visible file
        const visibleReq = new Request(`http://localhost/api/workspaces/${testWorkspace.id}/files/search?query=visible-file`);
        const visibleRes = await app.request(visibleReq);
        expect(visibleRes.status).toBe(200);
        const visibleJson = await visibleRes.json();
        expect(visibleJson).toEqual(['visible-file.txt']);
    });

    test('should work correctly with no .gitignore file', async () => {
        await fs.writeFile(join(testWorkspace.path, 'a-file.txt'), 'content');
        const req = new Request(`http://localhost/api/workspaces/${testWorkspace.id}/files/search?query=a-file`);
        const res = await app.request(req);
        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json).toEqual(['a-file.txt']);
    });

    test('should respect default ignores even with no .gitignore file', async () => {
        const nodeModulesDir = join(testWorkspace.path, 'node_modules');
        await fs.mkdir(nodeModulesDir);
        await fs.writeFile(join(nodeModulesDir, 'a-package.js'), 'content');

        const req = new Request(`http://localhost/api/workspaces/${testWorkspace.id}/files/search?query=a-package`);
        const res = await app.request(req);
        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json).toEqual([]);
    });

    test('should handle negation patterns in .gitignore', async () => {
        const gitignoreContent = 'dist/\n!dist/important.js';
        await fs.writeFile(join(testWorkspace.path, '.gitignore'), gitignoreContent);

        const distDir = join(testWorkspace.path, 'dist');
        await fs.mkdir(distDir);
        await fs.writeFile(join(distDir, 'ignored.js'), 'content');
        await fs.writeFile(join(distDir, 'important.js'), 'content');

        // Search for the ignored file
        const ignoredReq = new Request(`http://localhost/api/workspaces/${testWorkspace.id}/files/search?query=ignored`);
        const ignoredRes = await app.request(ignoredReq);
        expect(ignoredRes.status).toBe(200);
        const ignoredJson = await ignoredRes.json();
        expect(ignoredJson).toEqual([]);

        // Search for the un-ignored file
        const importantReq = new Request(`http://localhost/api/workspaces/${testWorkspace.id}/files/search?query=important`);
        const importantRes = await app.request(importantReq);
        expect(importantRes.status).toBe(200);
        const importantJson = await importantRes.json();
        expect(importantJson).toEqual(['dist/important.js']);
    });
});
