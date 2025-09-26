import { OpenAPIHono } from '@hono/zod-openapi';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { swaggerUI } from '@hono/swagger-ui';
import { workspaceManager, sessionManager, initializeManagers } from './managers';
import { workspaceRoutes } from './routes/workspaces';
import { settingsRoutes } from './routes/settings';
import { sessionRoutes } from './routes/sessions';
import { logger } from './logger';

const app = new OpenAPIHono({
  defaultHook: (result, c) => {
    if (!result.success) {
      return c.json(
        {
          error: 'Validation failed',
          issues: result.error.issues,
        },
        422,
      );
    }
  },
});

export { workspaceManager, sessionManager };

export async function initializeApp(baseDir?: string) {
    initializeManagers(baseDir);
    await workspaceManager.initialize();
    await sessionManager.initialize();
}

export function resetState(baseDir?: string) {
    initializeManagers(baseDir);
}

app.use('*', cors());

app.route('/api/workspaces', workspaceRoutes);
app.route('/api/sessions', sessionRoutes);
app.route('/api/settings', settingsRoutes);

app.doc('/openapi.json', {
  openapi: '3.1.0',
  info: {
    version: '1.0.0',
    title: 'Sumika API',
    description: 'An API for interacting with agents compatible with the Agent Client Protocol (ACP), such as the Gemini CLI. It provides stateful, multi-session chat with tool and streaming support.',
  },
});

app.get('/docs', swaggerUI({ url: '/openapi.json' }));

// --- Server Start ---
if (process.env.NODE_ENV !== 'test') {
    (async () => {
        const baseDir = process.env.SUMIKA_ROOT_DIR;
        try {
            await initializeApp(baseDir);
        } catch (err) {
            logger.error(err, 'Fatal: Failed to initialize application');
            process.exit(1);
        }
        const port = 8787;
        logger.info(`Server is running on port ${port}`);
        if (baseDir) {
            logger.info(`Using custom root directory: ${baseDir}`);
        }
        logger.info(`API documentation available at http://localhost:${port}/docs`);
        serve({
          fetch: app.fetch,
          port,
        });
    })();
}

export default app;