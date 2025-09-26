import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    afterEach,
    beforeEach, describe,
    expect, test,
} from 'vitest';

import { getWorkspaceManager, initializeApp, resetState } from '.';

import type { Workspace } from '@waylaidwanderer/sumika-types';

let testHomeDir: string;

beforeEach(async () => {
    // Create a unique temporary directory for each test
    testHomeDir = await fs.mkdtemp(join(tmpdir(), 'sumika-ws-test-'));

    resetState(testHomeDir);
    await initializeApp(testHomeDir);
});

afterEach(async () => {
    if (testHomeDir) {
        await fs.rm(testHomeDir, { recursive: true, force: true });
    }
});

describe('WorkspaceManager', () => {
    test('should create .sumika directory and default workspace on first initialize', async () => {
        const workspacesDir = join(testHomeDir, '.sumika', 'workspaces');
        await fs.stat(workspacesDir);
        const defaultWorkspace = getWorkspaceManager().getWorkspace('default-workspace');
        expect(defaultWorkspace).toBeDefined();
        expect(defaultWorkspace?.name).toBe('Default Workspace');

        const defaultWorkspaceDir = join(workspacesDir, 'default-workspace');
        const dirStats = await fs.stat(defaultWorkspaceDir);
        expect(dirStats.isDirectory()).toBe(true);
    });

    test('should load existing workspaces from metadata file', async () => {
        const loaded = getWorkspaceManager().getWorkspace('default-workspace');
        expect(loaded).toBeDefined();
        expect(loaded?.name).toBe('Default Workspace');
    });

    test('should handle corrupt workspaces.json by backing it up and creating a default', async () => {
        const metadataFile = join(testHomeDir, '.sumika', 'workspaces.json');
        // 1. Manually create a corrupt file after the initial setup
        await fs.writeFile(metadataFile, 'this is not json');

        // 2. Re-run the initialization logic
        resetState(testHomeDir);
        await initializeApp(testHomeDir);

        // 3. Check for backup
        const backupExists = await fs.stat(`${metadataFile}.bak`).then(() => true).catch(() => false);
        expect(backupExists).toBe(true);

        const defaultWorkspace = getWorkspaceManager().getWorkspace('default-workspace');
        expect(defaultWorkspace).toBeDefined();
    });

    test('should reconcile filesystem and metadata, removing orphaned entries', async () => {
        const workspacesDir = join(testHomeDir, '.sumika', 'workspaces');
        const metadataFile = join(testHomeDir, '.sumika', 'workspaces.json');
        // 1. Manually create an orphaned entry in the metadata
        const orphanWorkspace: Workspace = {
            id: 'orphan-ws',
            name: 'Orphan Workspace',
            description: 'This one has no directory',
            path: join(workspacesDir, 'orphan-ws'),
            createdAt: new Date().toISOString(),
            pinned: false,
            env: {},
            mcpServers: {},
        };
        const currentWorkspaces = getWorkspaceManager().getAllWorkspaces();
        const newMetadata = [...currentWorkspaces, orphanWorkspace];
        await fs.writeFile(metadataFile, JSON.stringify(newMetadata));

        // 2. Re-run the initialization logic
        resetState(testHomeDir);
        await initializeApp(testHomeDir);

        // 3. The orphan should have been removed
        const loaded = getWorkspaceManager().getWorkspace('orphan-ws');
        expect(loaded).toBeUndefined();

        // 4. The default workspace should still be there
        const defaultWorkspace = getWorkspaceManager().getWorkspace('default-workspace');
        expect(defaultWorkspace).toBeDefined();
    });

    test('createWorkspace should add a new workspace and save it', async () => {
        const metadataFile = join(testHomeDir, '.sumika', 'workspaces.json');
        // beforeEach already creates the default one
        const newWorkspace = await getWorkspaceManager().createWorkspace('My New Project', 'A brand new project.');
        expect(newWorkspace.name).toBe('My New Project');
        expect(newWorkspace.env).toEqual({});

        const loaded = getWorkspaceManager().getWorkspace(newWorkspace.id);
        expect(loaded).toBeDefined();
        expect(loaded?.description).toBe('A brand new project.');

        // Verify it was saved to disk
        const data = await fs.readFile(metadataFile, 'utf-8');
        const workspacesData = JSON.parse(data);
        expect(workspacesData.length).toBe(2); // Default + new one
        expect(workspacesData.some((w: unknown) => typeof w === 'object' && w !== null && 'id' in w && (w as { id: unknown }).id === newWorkspace.id)).toBe(true);
    });

    test('updateWorkspace should modify an existing workspace and save it', async () => {
        const metadataFile = join(testHomeDir, '.sumika', 'workspaces.json');
        const newWorkspace = await getWorkspaceManager().createWorkspace('Update Test');
        const updates = {
            name: 'Updated Name',
            description: 'Updated description.',
            pinned: true,
            env: { FOO: 'bar' },
        };

        const updated = await getWorkspaceManager().updateWorkspace(newWorkspace.id, updates);

        expect(updated?.name).toBe('Updated Name');
        expect(updated?.description).toBe('Updated description.');
        expect(updated?.pinned).toBe(true);
        expect(updated?.env).toEqual({ FOO: 'bar' });

        // Verify it was saved to disk
        const data = await fs.readFile(metadataFile, 'utf-8');
        const workspacesData = JSON.parse(data);
        const savedWorkspace = workspacesData.find((w: unknown) => typeof w === 'object' && w !== null && 'id' in w && (w as { id: unknown }).id === newWorkspace.id);
        expect(savedWorkspace.name).toBe('Updated Name');
        expect(savedWorkspace.env).toEqual({ FOO: 'bar' });
    });

    describe('deleteWorkspace and isWorkspaceEmpty', () => {
        test('isWorkspaceEmpty should return true for an empty directory', async () => {
            const ws = await getWorkspaceManager().createWorkspace('Empty Test');
            const isEmpty = await getWorkspaceManager().isWorkspaceEmpty(ws.id);
            expect(isEmpty).toBe(true);
        });

        test('isWorkspaceEmpty should return true for a directory with ignored files', async () => {
            const ws = await getWorkspaceManager().createWorkspace('Ignored Files Test');
            await fs.writeFile(join(ws.path, '.DS_Store'), '');
            const isEmpty = await getWorkspaceManager().isWorkspaceEmpty(ws.id);
            expect(isEmpty).toBe(true);
        });

        test('isWorkspaceEmpty should return false for a directory with content', async () => {
            const ws = await getWorkspaceManager().createWorkspace('Content Test');
            await fs.writeFile(join(ws.path, 'file.txt'), 'hello');
            const isEmpty = await getWorkspaceManager().isWorkspaceEmpty(ws.id);
            expect(isEmpty).toBe(false);
        });

        test('deleteWorkspace should remove a managed workspace and its files if deleteFiles is true', async () => {
            const ws = await getWorkspaceManager().createWorkspace('Delete Me');
            await fs.writeFile(join(ws.path, 'file.txt'), 'hello');

            const success = await getWorkspaceManager().deleteWorkspace(ws.id, true);
            expect(success).toBe(true);

            // Verify metadata is gone
            expect(getWorkspaceManager().getWorkspace(ws.id)).toBeUndefined();

            // Verify directory is gone
            const dirExists = await fs.stat(ws.path).then(() => true).catch(() => false);
            expect(dirExists).toBe(false);
        });

        test('deleteWorkspace should only remove metadata if deleteFiles is false', async () => {
            const ws = await getWorkspaceManager().createWorkspace('Keep Files');
            await fs.writeFile(join(ws.path, 'file.txt'), 'hello');

            const success = await getWorkspaceManager().deleteWorkspace(ws.id, false);
            expect(success).toBe(true);

            // Verify metadata is gone
            expect(getWorkspaceManager().getWorkspace(ws.id)).toBeUndefined();

            // Verify directory still exists
            const dirExists = await fs.stat(ws.path).then(() => true).catch(() => false);
            expect(dirExists).toBe(true);
        });

        test('deleteWorkspace should throw an error when trying to delete files for a custom-path workspace', async () => {
            const customPath = await fs.mkdtemp(join(tmpdir(), 'custom-ws-'));
            const ws = await getWorkspaceManager().createWorkspace('Custom Path WS', '', customPath);

            await expect(getWorkspaceManager().deleteWorkspace(ws.id, true))
                .rejects
                .toThrow('Cannot delete files for a custom-path workspace.');

            // Cleanup the temp dir
            await fs.rm(customPath, { recursive: true, force: true });
        });

        test('deleteWorkspace should remove metadata for a custom-path workspace if deleteFiles is false', async () => {
            const customPath = await fs.mkdtemp(join(tmpdir(), 'custom-ws-'));
            await fs.writeFile(join(customPath, 'file.txt'), 'hello');
            const ws = await getWorkspaceManager().createWorkspace('Custom Path Keep', '', customPath);

            const success = await getWorkspaceManager().deleteWorkspace(ws.id, false);
            expect(success).toBe(true);

            // Verify metadata is gone
            expect(getWorkspaceManager().getWorkspace(ws.id)).toBeUndefined();

            // Verify directory still exists
            const dirExists = await fs.stat(customPath).then(() => true).catch(() => false);
            expect(dirExists).toBe(true);

            // Cleanup the temp dir
            await fs.rm(customPath, { recursive: true, force: true });
        });
    });
});

describe('Reconciliation Logic', () => {
    test('should remove a custom-path workspace if its directory is missing', async () => {
        const metadataFile = join(testHomeDir, '.sumika', 'workspaces.json');
        // 1. Manually create a metadata file with a custom path that doesn't exist
        const customWorkspace: Workspace = {
            id: 'custom-ws',
            name: 'Custom Workspace',
            description: 'A custom path that does not exist',
            path: '/tmp/non-existent-path-for-testing',
            createdAt: new Date().toISOString(),
            pinned: false,
            env: {},
            mcpServers: {},
        };
        const currentWorkspaces = getWorkspaceManager().getAllWorkspaces();
        const newMetadata = [...currentWorkspaces, customWorkspace];
        await fs.writeFile(metadataFile, JSON.stringify(newMetadata));

        // 2. Re-run the initialization logic
        resetState(testHomeDir);
        await initializeApp(testHomeDir);

        // 3. The custom workspace should have been removed
        const loaded = getWorkspaceManager().getWorkspace('custom-ws');
        expect(loaded).toBeUndefined();

        // 4. The default workspace should still be there
        const defaultWorkspace = getWorkspaceManager().getWorkspace('default-workspace');
        expect(defaultWorkspace).toBeDefined();
    });

    test('should NOT remove a custom-path workspace if its directory exists', async () => {
        const metadataFile = join(testHomeDir, '.sumika', 'workspaces.json');
        // 1. Create a temporary directory for the custom path
        const customPath = await fs.mkdtemp(join(tmpdir(), 'custom-ws-test-'));

        // 2. Manually create a metadata file pointing to the existing custom path
        const customWorkspace: Workspace = {
            id: 'custom-ws-2',
            name: 'Custom Workspace 2',
            description: 'A custom path that exists',
            path: customPath,
            createdAt: new Date().toISOString(),
            pinned: false,
            env: {},
            mcpServers: {},
        };
        const currentWorkspaces = getWorkspaceManager().getAllWorkspaces();
        const newMetadata = [...currentWorkspaces, customWorkspace];
        await fs.writeFile(metadataFile, JSON.stringify(newMetadata));

        // 3. Re-run the initialization logic
        resetState(testHomeDir);
        await initializeApp(testHomeDir);

        // 4. The custom workspace should still be there
        const loaded = getWorkspaceManager().getWorkspace('custom-ws-2');
        expect(loaded).toBeDefined();
        expect(loaded?.path).toBe(customPath);

        const defaultWorkspace = getWorkspaceManager().getWorkspace('default-workspace');
        expect(defaultWorkspace).toBeDefined();

        // 6. Cleanup the temp dir
        await fs.rm(customPath, { recursive: true, force: true });
    });
});
