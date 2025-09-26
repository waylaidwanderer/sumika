import { promises as fs } from 'node:fs';
import { basename, join } from 'node:path';

import { createRoute, OpenAPIHono } from '@hono/zod-openapi';
import { UpdateWorkspaceSchema, WorkspaceSchema } from '@waylaidwanderer/sumika-types';
import Fuse from 'fuse.js';
import { glob } from 'glob';
import ignore from 'ignore';
import { z } from 'zod';

import logger from '../logger';
import { getWorkspaceManager } from '../managers';

const DEFAULT_FILE_SEARCH_IGNORES = ['node_modules/**', '.git/**', 'dist/**', 'build/**', '**/.gitignore'];

const expandGitignorePatterns = (gitignoreRaw: string): string[] => {
    const patterns: string[] = [];
    const seen = new Set<string>();

    gitignoreRaw.split(/\r?\n/).forEach((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) {
            return;
        }

        if (!seen.has(trimmed)) {
            patterns.push(trimmed);
            seen.add(trimmed);
        }

        if (!trimmed.startsWith('!')) {
            return;
        }

        const withoutBang = trimmed.slice(1);
        if (!withoutBang) {
            return;
        }

        const segments = withoutBang.split('/').filter(Boolean);
        if (segments.length <= 1) {
            return;
        }

        let prefix = '';
        for (let i = 0; i < segments.length - 1; i++) {
            prefix = prefix ? `${prefix}/${segments[i]}` : segments[i];
            const unignoreDir = `!${prefix}/`;
            if (!seen.has(unignoreDir)) {
                patterns.push(unignoreDir);
                seen.add(unignoreDir);
            }
        }
    });

    return patterns;
};

const workspaceRoutes = new OpenAPIHono();

export default workspaceRoutes;

workspaceRoutes.openapi(createRoute({
    method: 'get',
    path: '/',
    summary: 'List all workspaces',
    responses: {
        200: {
            description: 'A list of all workspaces',
            content: {
                'application/json': {
                    schema: z.array(WorkspaceSchema),
                },
            },
        },
    },
}), (c) => {
    const workspaces = getWorkspaceManager().getAllWorkspaces();
    return c.json(workspaces, 200);
});

workspaceRoutes.openapi(createRoute({
    method: 'post',
    path: '/',
    summary: 'Create a new workspace',
    request: {
        body: {
            content: {
                'application/json': {
                    schema: z.object({
                        name: z.string(),
                        description: z.string().optional(),
                        path: z.string().optional(),
                    }),
                },
            },
        },
    },
    responses: {
        201: {
            description: 'The newly created workspace object',
            content: {
                'application/json': {
                    schema: WorkspaceSchema,
                },
            },
        },
        400: {
            description: 'Invalid path provided',
            content: {
                'application/json': {
                    schema: z.object({ error: z.string() }),
                },
            },
        },
        409: {
            description: 'Path is already in use',
            content: {
                'application/json': {
                    schema: z.object({ error: z.string() }),
                },
            },
        },
        500: {
            description: 'Internal server error',
            content: {
                'application/json': {
                    schema: z.object({ error: z.string() }),
                },
            },
        },
    },
}), async (c) => {
    const { name, description, path } = c.req.valid('json');
    try {
        const newWorkspace = await getWorkspaceManager().createWorkspace(name, description, path);
        return c.json(newWorkspace, 201);
    } catch (error) {
        if (error instanceof Error) {
            if (error.message.includes('is not a directory') || error.message.includes('does not exist') || error.message.includes('Invalid path provided')) {
                return c.json({ error: error.message }, 400);
            }
            if (error.message.includes('Path is already in use')) {
                return c.json({ error: error.message }, 409);
            }
        }
        logger.error({
            err: error, name, description, customPath: path,
        }, 'Failed to create workspace');
        return c.json({ error: 'An internal server error occurred.' }, 500);
    }
});

workspaceRoutes.openapi(createRoute({
    method: 'get',
    path: '/{workspaceId}',
    summary: 'Get a single workspace by ID',
    request: {
        params: z.object({ workspaceId: z.string() }),
    },
    responses: {
        200: {
            description: 'The workspace object',
            content: { 'application/json': { schema: WorkspaceSchema } },
        },
        404: {
            description: 'Workspace not found',
            content: { 'application/json': { schema: z.object({ error: z.string() }) } },
        },
    },
}), (c) => {
    const { workspaceId } = c.req.valid('param');
    const workspace = getWorkspaceManager().getWorkspace(workspaceId);
    if (!workspace) {
        return c.json({ error: 'Workspace not found' }, 404);
    }
    return c.json(workspace, 200);
});

workspaceRoutes.openapi(createRoute({
    method: 'get',
    path: '/{workspaceId}/check-emptiness',
    summary: 'Check if a workspace directory is empty',
    request: {
        params: z.object({ workspaceId: z.string() }),
    },
    responses: {
        200: {
            description: 'Returns whether the directory is empty',
            content: { 'application/json': { schema: z.object({ isEmpty: z.boolean() }) } },
        },
        404: {
            description: 'Workspace not found',
            content: { 'application/json': { schema: z.object({ error: z.string() }) } },
        },
        500: {
            description: 'An unexpected error occurred',
            content: { 'application/json': { schema: z.object({ error: z.string() }) } },
        },
    },
}), async (c) => {
    const { workspaceId } = c.req.valid('param');
    try {
        const isEmpty = await getWorkspaceManager().isWorkspaceEmpty(workspaceId);
        return c.json({ isEmpty }, 200);
    } catch (error) {
        if (error instanceof Error && error.message.includes('not found')) {
            return c.json({ error: error.message }, 404);
        }
        return c.json({ error: 'An unexpected error occurred' }, 500);
    }
});

workspaceRoutes.openapi(createRoute({
    method: 'put',
    path: '/{workspaceId}',
    summary: 'Update a workspace',
    request: {
        params: z.object({ workspaceId: z.string() }),
        body: {
            content: {
                'application/json': {
                    schema: UpdateWorkspaceSchema,
                },
            },
        },
    },
    responses: {
        200: {
            description: 'The updated workspace object',
            content: { 'application/json': { schema: WorkspaceSchema } },
        },
        404: {
            description: 'Workspace not found',
            content: { 'application/json': { schema: z.object({ error: z.string() }) } },
        },
    },
}), async (c) => {
    const { workspaceId } = c.req.valid('param');
    const updates = c.req.valid('json');
    const updatedWorkspace = await getWorkspaceManager().updateWorkspace(workspaceId, updates);
    if (!updatedWorkspace) {
        return c.json({ error: 'Workspace not found' }, 404);
    }
    return c.json(updatedWorkspace, 200);
});

workspaceRoutes.openapi(createRoute({
    method: 'delete',
    path: '/{workspaceId}',
    summary: 'Delete a workspace by ID',
    request: {
        params: z.object({ workspaceId: z.string() }),
        query: z.object({
            deleteFiles: z.string().optional().transform((val) => val === 'true'),
        }),
    },
    responses: {
        204: {
            description: 'Workspace deleted successfully',
        },
        400: {
            description: 'Bad request, e.g., trying to delete files for a custom-path workspace',
            content: { 'application/json': { schema: z.object({ error: z.string() }) } },
        },
        404: {
            description: 'Workspace not found',
            content: { 'application/json': { schema: z.object({ error: z.string() }) } },
        },
    },
}), async (c) => {
    const { workspaceId } = c.req.valid('param');
    const { deleteFiles } = c.req.valid('query');

    try {
        const success = await getWorkspaceManager().deleteWorkspace(workspaceId, deleteFiles || false);
        if (!success) {
            return c.json({ error: 'Workspace not found' }, 404);
        }
        return new Response(null, { status: 204 });
    } catch (error) {
        if (error instanceof Error) {
            if (error.message.includes('Cannot delete files for a custom-path workspace')) {
                return c.json({ error: error.message }, 400);
            }
        }
        return c.json({ error: 'An unexpected error occurred' }, 500);
    }
});

const FileExistsRoute = createRoute({
    method: 'get',
    path: '/{workspaceId}/files/exists',
    summary: 'Check if a file exists in a workspace',
    request: {
        params: z.object({ workspaceId: z.string() }),
        query: z.object({
            filename: z.string(),
        }),
    },
    responses: {
        200: {
            description: 'File existence status',
            content: { 'application/json': { schema: z.object({ exists: z.boolean() }) } },
        },
        404: { description: 'Workspace not found' },
    },
});

workspaceRoutes.openapi(FileExistsRoute, async (c) => {
    const { workspaceId } = c.req.valid('param');
    const { filename } = c.req.valid('query');
    const workspace = getWorkspaceManager().getWorkspace(workspaceId);

    if (!workspace) {
        return c.json({ error: 'Workspace not found' }, 404);
    }

    const sanitizedFilename = basename(filename);
    const filePath = join(workspace.path, sanitizedFilename);

    try {
        await fs.access(filePath);
        return c.json({ exists: true }, 200);
    } catch {
        return c.json({ exists: false }, 200);
    }
});

const UploadFileRoute = createRoute({
    method: 'post',
    path: '/{workspaceId}/upload',
    summary: 'Upload a file to a workspace',
    request: {
        params: z.object({ workspaceId: z.string() }),
        query: z.object({
            overwrite: z.string().optional().transform((val) => val === 'true'),
        }),
        body: {
            content: {
                'multipart/form-data': {
                    schema: z.object({
                        file: z.any().openapi({
                            type: 'string',
                            format: 'binary',
                        }),
                    }),
                },
            },
        },
    },
    responses: {
        201: { description: 'File uploaded successfully' },
        400: { description: 'Bad request (e.g., no file provided)' },
        404: { description: 'Workspace not found' },
        409: { description: 'File already exists and overwrite is not set to true' },
        413: { description: 'File size exceeds the 100MB limit' },
        500: { description: 'Internal server error' },
    },
});

workspaceRoutes.openapi(UploadFileRoute, async (c) => {
    const { workspaceId } = c.req.valid('param');
    const { overwrite } = c.req.valid('query');
    const workspace = getWorkspaceManager().getWorkspace(workspaceId);

    if (!workspace) {
        return c.json({ error: 'Workspace not found' }, 404);
    }

    const body = await c.req.parseBody();
    const { file } = body;

    if (!(file instanceof File)) {
        return c.json({ error: 'No file provided in the upload.' }, 400);
    }

    const MAX_FILE_SIZE = 100 * 1024 * 1024;
    if (file.size > MAX_FILE_SIZE) {
        return c.json({ error: 'File size exceeds the 100MB limit.' }, 413);
    }

    const sanitizedFilename = basename(file.name);
    const destinationPath = join(workspace.path, sanitizedFilename);

    if (!overwrite) {
        try {
            await fs.access(destinationPath);
            return c.json({ error: 'File already exists. Set overwrite=true to replace it.' }, 409);
        } catch {
            // File doesn't exist, proceed
        }
    }

    try {
        const arrayBuffer = await file.arrayBuffer();
        await fs.writeFile(destinationPath, Buffer.from(arrayBuffer));
        return c.json({ message: 'File uploaded successfully.', filename: sanitizedFilename }, 201);
    } catch (error) {
        logger.error({ err: error }, `Error saving uploaded file for workspace ${workspaceId}:`);
        return c.json({ error: 'Failed to save the uploaded file.' }, 500);
    }
});

const FileSearchRoute = createRoute({
    method: 'get',
    path: '/{workspaceId}/files/search',
    summary: 'Search for files within a workspace',
    request: {
        params: z.object({ workspaceId: z.string() }),
        query: z.object({
            query: z.string(),
        }),
    },
    responses: {
        200: {
            description: 'A list of matching file paths, relative to the workspace root.',
            content: { 'application/json': { schema: z.array(z.string()) } },
        },
        404: { description: 'Workspace not found' },
    },
});

workspaceRoutes.openapi(FileSearchRoute, async (c) => {
    const { workspaceId } = c.req.valid('param');
    const { query } = c.req.valid('query');
    const workspace = getWorkspaceManager().getWorkspace(workspaceId);

    if (!workspace) {
        return c.json({ error: 'Workspace not found' }, 404);
    }

    try {
        const ig = ignore();
        ig.add(DEFAULT_FILE_SEARCH_IGNORES);

        const gitignorePath = join(workspace.path, '.gitignore');
        try {
            await fs.access(gitignorePath);
            const gitignore = await fs.readFile(gitignorePath, 'utf-8');
            const gitignorePatterns = expandGitignorePatterns(gitignore);
            if (gitignorePatterns.length > 0) {
                ig.add(gitignorePatterns);
            }
        } catch {
            // Ignore if .gitignore doesn't exist
        }

        const allFiles = await glob('**/*', {
            cwd: workspace.path,
            nodir: true,
            dot: true,
        });

        const files = ig.filter(allFiles);
        if (query) {
            const fuse = new Fuse(files, {
                includeScore: true,
                threshold: 0.4,
            });
            const results = fuse.search(query).map((result) => result.item);

            return c.json(results, 200);
        }

        return c.json(files, 200);
    } catch (error) {
        logger.error(
            { err: error, workspaceId, query },
            'Workspace file search failed',
        );
        return c.json({ error: 'Failed to search workspace files.' }, 500);
    }
});
