import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { SettingsSchema } from '@waylaidwanderer/sumika-types';
import { workspaceManager, sessionManager } from '../managers';
import { loadSettings, saveSettings } from '../settings';

const settingsRoutes = new OpenAPIHono()
    .openapi(
        {
            method: 'get',
            path: '/',
            summary: 'Get global settings',
            responses: {
                200: {
                    description: 'Returns the global settings file content.',
                    content: {
                        'application/json': {
                            schema: SettingsSchema,
                        },
                    },
                },
            },
        },
        async (c) => {
            const settings = await loadSettings(workspaceManager.sumikaDir);
            return c.json(settings);
        }
    )
    .openapi(
        {
            method: 'put',
            path: '/',
            summary: 'Update global settings',
            request: {
                body: {
                    content: {
                        'application/json': {
                            schema: SettingsSchema,
                        },
                    },
                },
            },
            responses: {
                200: {
                    description: 'Returns the updated settings file content.',
                    content: {
                        'application/json': {
                            schema: SettingsSchema,
                        },
                    },
                },
                400: {
                    description: 'Invalid settings payload.',
                },
            },
        },
        async (c) => {
            const payload = c.req.valid('json');
            await saveSettings(workspaceManager.sumikaDir, payload);
            const after = await loadSettings(workspaceManager.sumikaDir);
            return c.json(after);
        }
    );

export { settingsRoutes };

const RestartAgentRoute = createRoute({
  method: 'post',
  path: '/restart-agent',
  summary: 'Restart the agent process',
  description: 'Restarts the underlying agent process to apply changes to environment variables or the custom agent command.',
  responses: {
    200: {
      description: 'Agent restart initiated',
      content: { 'application/json': { schema: z.object({ message: z.string() }) } },
    },
  },
});

settingsRoutes.openapi(RestartAgentRoute, async (c) => {
  sessionManager.restartAgentProcess();
  return c.json({ message: 'Agent restart initiated' }, 200);
});

