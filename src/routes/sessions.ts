import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import {
    PromptContentSchema,
    SessionDataSchema,
} from '@waylaidwanderer/sumika-types';
import { streamSSE } from 'hono/streaming';

import { ErrorSchema, SessionIdSchema } from '../api-types';
import logger from '../logger';
import { getSessionManager, getWorkspaceManager } from '../managers';

import type { UserMessage } from '@waylaidwanderer/sumika-types';

const sessionRoutes = new OpenAPIHono();

export default sessionRoutes;

const GetSessionsRoute = createRoute({
    method: 'get',
    path: '/',
    summary: 'List all chat sessions for a workspace',
    request: {
        query: z.object({
            workspaceId: z.string().optional().openapi({
                description: 'If provided, only sessions for this workspace will be returned.',
                example: 'default-workspace',
            }),
            limit: z.coerce.number().optional().default(20).openapi({
                description: 'The maximum number of sessions to return.',
                example: 50,
            }),
            offset: z.coerce.number().optional().default(0).openapi({
                description: 'The number of sessions to skip before starting to collect the result set.',
                example: 0,
            }),
            view: z.enum(['summary', 'full']).optional().default('full').openapi({
                description: 'If set to `summary`, the `messages` array will be excluded from the response.',
                example: 'summary',
            }),
        }),
    },
    responses: {
        200: {
            description: 'A list of all sessions',
            content: {
                'application/json': {
                    schema: z.array(SessionDataSchema),
                },
            },
        },
    },
});

sessionRoutes.openapi(GetSessionsRoute, (c) => {
    const {
        workspaceId, limit, offset, view,
    } = c.req.valid('query');
    const sessions = getSessionManager().getAllSessions({
        workspaceId, limit, offset, view,
    });
    return c.json(sessions, 200);
});

const CreateSessionRoute = createRoute({
    method: 'post',
    path: '/',
    summary: 'Create a new chat session',
    request: {
        body: {
            content: {
                'application/json': {
                    schema: z.object({
                        workspaceId: z.string(),
                    }),
                },
            },
        },
    },
    responses: {
        200: {
            description: 'The newly created session object',
            content: {
                'application/json': {
                    schema: SessionDataSchema,
                },
            },
        },
        500: {
            description: 'Failed to create session',
            content: { 'application/json': { schema: ErrorSchema } },
        },
    },
});

sessionRoutes.openapi(CreateSessionRoute, async (c) => {
    try {
        const { workspaceId } = c.req.valid('json');
        const sessionId = await getSessionManager().createSession(workspaceId);
        const newSession = getSessionManager().getSession(sessionId);
        return c.json(newSession, 200);
    } catch {
        return c.json({ error: 'Failed to create session' }, 500);
    }
});

const GetSessionByIdRoute = createRoute({
    method: 'get',
    path: '/{sessionId}',
    summary: 'Get a single session by ID',
    request: {
        params: z.object({ sessionId: SessionIdSchema }),
    },
    responses: {
        200: {
            description: 'The session object',
            content: { 'application/json': { schema: SessionDataSchema } },
        },
        404: {
            description: 'Session not found',
            content: { 'application/json': { schema: ErrorSchema } },
        },
    },
});

sessionRoutes.openapi(GetSessionByIdRoute, (c) => {
    const { sessionId } = c.req.valid('param');
    const session = getSessionManager().getSession(sessionId);
    if (!session) {
        return c.json({ error: 'Session not found' }, 404);
    }
    return c.json(session, 200);
});

const DeleteSessionRoute = createRoute({
    method: 'delete',
    path: '/{sessionId}',
    summary: 'Delete a session by ID',
    request: {
        params: z.object({ sessionId: SessionIdSchema }),
    },
    responses: {
        204: {
            description: 'Session deleted successfully',
        },
        404: {
            description: 'Session not found',
            content: { 'application/json': { schema: ErrorSchema } },
        },
    },
});

sessionRoutes.openapi(DeleteSessionRoute, (c) => {
    const { sessionId } = c.req.valid('param');
    const success = getSessionManager().deleteSession(sessionId);
    if (!success) {
        return c.json({ error: 'Session not found' }, 404);
    }
    return new Response(null, { status: 204 });
});

const UpdateSessionRoute = createRoute({
    method: 'patch',
    path: '/{sessionId}',
    summary: 'Update a session (e.g., rename, pin)',
    request: {
        params: z.object({ sessionId: SessionIdSchema }),
        body: {
            content: {
                'application/json': {
                    schema: z.object({
                        name: z.string().optional().openapi({ example: 'My Important Session' }),
                        pinned: z.boolean().optional().openapi({ example: true }),
                    }),
                },
            },
        },
    },
    responses: {
        200: {
            description: 'The updated session object',
            content: { 'application/json': { schema: SessionDataSchema } },
        },
        404: {
            description: 'Session not found',
            content: { 'application/json': { schema: ErrorSchema } },
        },
    },
});

sessionRoutes.openapi(UpdateSessionRoute, async (c) => {
    const { sessionId } = c.req.valid('param');
    const updates = c.req.valid('json');

    const updatedSession = getSessionManager().updateSession(sessionId, updates);
    if (!updatedSession) {
        return c.json({ error: 'Session not found' }, 404);
    }
    return c.json(updatedSession, 200);
});

const ExportSessionRoute = createRoute({
    method: 'get',
    path: '/{sessionId}/export',
    summary: 'Export a session history as Markdown',
    request: {
        params: z.object({ sessionId: SessionIdSchema }),
    },
    responses: {
        200: {
            description: 'A Markdown file of the session history',
            headers: {
                'Content-Disposition': { schema: { type: 'string', example: 'attachment; filename="session-history.md"' } },
            },
            content: { 'text/markdown': { schema: z.string() } },
        },
        404: {
            description: 'Session not found',
            content: { 'application/json': { schema: ErrorSchema } },
        },
    },
});

sessionRoutes.openapi(ExportSessionRoute, (c) => {
    const { sessionId } = c.req.valid('param');
    const markdown = getSessionManager().exportSessionToMarkdown(sessionId);
    if (markdown === '') {
        return c.json({ error: 'Session not found' }, 404);
    }

    const sessionName = getSessionManager().getSession(sessionId)?.name ?? 'session';
    const filename = `${sessionName.replace(/[^a-z0-9]/gi, '_').toLowerCase()}.md`;

    c.header('Content-Type', 'text/markdown');
    c.header('Content-Disposition', `attachment; filename="${filename}"`);
    return c.body(markdown, 200);
});

const BranchSessionRoute = createRoute({
    method: 'post',
    path: '/{sessionId}/branch',
    summary: 'Create a new session by branching from a specific message',
    request: {
        params: z.object({ sessionId: SessionIdSchema }),
        body: {
            content: {
                'application/json': {
                    schema: z.object({
                        branchFromMessageId: z.string().openapi({
                            description: 'The ID of the agent message to branch from.',
                            example: 'msg-12345',
                        }),
                    }),
                },
            },
        },
    },
    responses: {
        201: {
            description: 'The newly created branched session object',
            content: { 'application/json': { schema: SessionDataSchema } },
        },
        400: {
            description: 'Bad request (e.g., trying to branch from a non-agent message)',
            content: { 'application/json': { schema: ErrorSchema } },
        },
        404: {
            description: 'Original session or message not found',
            content: { 'application/json': { schema: ErrorSchema } },
        },
        500: {
            description: 'An internal server error occurred',
            content: { 'application/json': { schema: ErrorSchema } },
        },
    },
});

sessionRoutes.openapi(BranchSessionRoute, async (c) => {
    const { sessionId } = c.req.valid('param');
    const { branchFromMessageId } = c.req.valid('json');

    try {
        const newSession = await getSessionManager().branchSession(sessionId, branchFromMessageId);
        return c.json(newSession, 201);
    } catch (error) {
        if (error instanceof Error) {
            if (error.message.includes('not found')) {
                return c.json({ error: error.message }, 404);
            }
            if (error.message.includes('only supported from agent messages')) {
                return c.json({ error: error.message }, 400);
            }
        }
        logger.error({ err: error, sessionId }, 'Failed to branch session');
        return c.json({ error: 'An internal server error occurred while branching the session.' }, 500);
    }
});

const ListenRoute = createRoute({
    method: 'get',
    path: '/{sessionId}/listen',
    summary: 'Listen for session events (SSE)',
    description: 'Establishes a Server-Sent Events (SSE) connection to receive real-time updates from the agent. The stream provides various event types, including agent output chunks, tool calls, and permission requests.',
    request: {
        params: z.object({ sessionId: SessionIdSchema }),
    },
    responses: {
        200: {
            description: 'A stream of Server-Sent Events. Each event is a JSON object.',
            content: {
                'text/event-stream': {
                    schema: z.string().openapi({
                        example: `
data: {"type":"ready"}

data: {"type":"chunk","sessionUpdate":"agent_message_chunk","content":{"text":"I can write to a file for you. "}}

data: {"type":"chunk","sessionUpdate":"agent_thought_chunk","content":{"text":"Okay, planning to use the write_file tool."}}

data: {"type":"chunk","sessionUpdate":"tool_call","toolCallId":"write_file-123","title":"Write to file.txt","content":[{"type":"content","content":{"text":"What should the content be?"}}],"status":"pending"}}

data: {"type":"permission_request","requestId":4,"options":[{"optionId":"allow-once-123","name":"Allow Once","kind":"allow_once"}],"toolCall":{"toolCallId":"write_file-123","title":"Write to file.txt","content":[{"type":"content","content":{"text":"What should the content be?"}}],"status":"pending"}}

data: {"type":"chunk","sessionUpdate":"tool_call_update","toolCallId":"write_file-123","status":"completed","content":[{"type":"content","content":{"text":"File written successfully."}}]}

data: {"type":"end","stopReason":"end_turn"}
`,
                    }),
                },
            },
        },
        404: {
            description: 'Session not found',
            content: { 'application/json': { schema: ErrorSchema } },
        },
    },
});

sessionRoutes.openapi(ListenRoute, async (c) => {
    const { sessionId } = c.req.valid('param');
    const session = getSessionManager().getSession(sessionId);
    if (!session) {
        return c.json({ error: 'Session not found' }, 404);
    }

    return streamSSE(c, async (stream) => {
        getSessionManager().registerStream(sessionId, stream);
        stream.write(`${JSON.stringify({ type: 'ready' })}\n`);

        const intervalId = setInterval(() => {
            stream.write(`${JSON.stringify({ type: 'ping' })}\n`);
        }, 30000);

        stream.onAbort(() => {
            logger.info({ sessionId }, 'Client disconnected');
            clearInterval(intervalId);
        });

        await new Promise(() => {}); // Keep the connection open indefinitely
    });
});

const PromptRoute = createRoute({
    method: 'post',
    path: '/{sessionId}/prompt',
    summary: 'Send a prompt to the session',
    description: 'Sends a user prompt to the agent. The server will respond with the created user message object. The agent\'s response will be delivered asynchronously via the SSE stream on the `/{sessionId}/listen` endpoint.',
    request: {
        params: z.object({ sessionId: SessionIdSchema }),
        body: {
            content: {
                'application/json': {
                    schema: z.object({
                        content: z.array(PromptContentSchema).openapi({ example: [{ type: 'text', text: 'Tell me a joke.' }] }),
                    }),
                },
            },
        },
    },
    responses: {
        201: {
            description: 'Prompt accepted and user message created.',
            content: { 'application/json': { schema: z.custom<UserMessage>().openapi({ type: 'object', description: 'The created UserMessage object' }) } },
        },
        404: { description: 'Session not found', content: { 'application/json': { schema: ErrorSchema } } },
        500: { description: 'Workspace for session not found', content: { 'application/json': { schema: ErrorSchema } } },
    },
});

sessionRoutes.openapi(PromptRoute, async (c) => {
    const { sessionId } = c.req.valid('param');
    const { content } = c.req.valid('json');

    const session = getSessionManager().getSession(sessionId);
    if (!session) {
        return c.json({ error: 'Session not found' }, 404);
    }

    const workspace = getWorkspaceManager().getWorkspace(session.workspaceId);
    if (!workspace) {
        return c.json({ error: 'Workspace for session not found' }, 500);
    }

    const finalContent = await getSessionManager().processFileMentions(session.workspaceId, content);

    const newUserMessage = getSessionManager().addUserMessage(sessionId, finalContent);
    getSessionManager().prompt(sessionId, finalContent);
    return c.json(newUserMessage, 201);
});

const PermissionRoute = createRoute({
    method: 'post',
    path: '/{sessionId}/permission',
    summary: 'Respond to a tool call permission request',
    description: 'Used to grant or deny permission for a tool call requested by the agent. The `requestId` should correspond to a `permission_request` event received from the `/listen` endpoint.',
    request: {
        params: z.object({ sessionId: SessionIdSchema }),
        body: {
            content: {
                'application/json': {
                    schema: z.object({
                        requestId: z.number().openapi({ example: 12345 }),
                        outcome: z.object({
                            outcome: z.literal('selected'),
                            optionId: z.string().openapi({
                                description: 'The chosen permission option.',
                                examples: [
                                    'proceed_once',
                                    'deny_once',
                                    'allow_all',
                                ],
                            }),
                        }).openapi({
                            examples: [
                                { outcome: 'selected', optionId: 'proceed_once' },
                                { outcome: 'selected', optionId: 'deny_once' },
                                { outcome: 'selected', optionId: 'allow_all' },
                            ],
                        }),
                    }),
                },
            },
        },
    },
    responses: {
        200: { description: 'Permission response sent successfully.', content: { 'application/json': { schema: z.object({ message: z.string() }) } } },
        404: { description: 'Session not found', content: { 'application/json': { schema: ErrorSchema } } },
    },
});

sessionRoutes.openapi(PermissionRoute, async (c) => {
    const { sessionId } = c.req.valid('param');
    const { requestId, outcome } = c.req.valid('json');

    const session = getSessionManager().getSession(sessionId);
    if (!session) {
        return c.json({ error: 'Session not found' }, 404);
    }

    getSessionManager().sendPermissionResponse(requestId, outcome);
    getSessionManager().updatePermissionRequestMessage(sessionId, requestId, outcome.optionId);
    return c.json({ message: 'Permission response sent' }, 200);
});

const CancelRoute = createRoute({
    method: 'post',
    path: '/{sessionId}/cancel',
    summary: 'Cancel the current agent prompt',
    description: 'Sends a request to interrupt and cancel the currently in-progress agent prompt. The agent will stop generating output.',
    request: {
        params: z.object({ sessionId: SessionIdSchema }),
    },
    responses: {
        200: { description: 'Cancel request sent successfully.', content: { 'application/json': { schema: z.object({ message: z.string() }) } } },
        404: { description: 'Session not found', content: { 'application/json': { schema: ErrorSchema } } },
    },
});

sessionRoutes.openapi(CancelRoute, (c) => {
    const { sessionId } = c.req.valid('param');
    const session = getSessionManager().getSession(sessionId);
    if (!session) {
        return c.json({ error: 'Session not found' }, 404);
    }
    getSessionManager().cancel(sessionId);
    return c.json({ message: 'Cancel request sent' }, 200);
});

const ReloadSessionRoute = createRoute({
    method: 'post',
    path: '/{sessionId}/reload',
    summary: 'Reload a session by creating a new ACP session and carrying over chat history',
    request: {
        params: z.object({ sessionId: SessionIdSchema }),
    },
    responses: {
        200: { description: 'Session reloaded successfully.', content: { 'application/json': { schema: SessionDataSchema } } },
        404: { description: 'Session not found', content: { 'application/json': { schema: ErrorSchema } } },
        500: { description: 'Failed to reload session', content: { 'application/json': { schema: ErrorSchema } } },
    },
});

sessionRoutes.openapi(ReloadSessionRoute, async (c) => {
    const { sessionId } = c.req.valid('param');
    const existing = getSessionManager().getSession(sessionId);
    if (!existing) {
        return c.json({ error: 'Session not found' }, 404);
    }
    try {
        const newId = await getSessionManager().reloadSession(sessionId);
        if (!newId) {
            return c.json({ error: 'Session not found' }, 404);
        }
        const updated = getSessionManager().getSession(sessionId);
        if (!updated) {
            return c.json({ error: 'Session not found after reload' }, 500);
        }
        return c.json(updated, 200);
    } catch (error) {
        logger.error({ err: error }, 'Failed to reload session');
        return c.json({ error: 'Failed to reload session' }, 500);
    }
});

const CompressSessionRoute = createRoute({
    method: 'post',
    path: '/{sessionId}/compress',
    summary: 'Compress the chat history of a session',
    request: {
        params: z.object({ sessionId: SessionIdSchema }),
    },
    responses: {
        200: { description: 'Session compressed successfully.', content: { 'application/json': { schema: SessionDataSchema } } },
        404: { description: 'Session not found', content: { 'application/json': { schema: ErrorSchema } } },
        409: { description: 'Compression failed because the new history was not smaller.', content: { 'application/json': { schema: ErrorSchema } } },
        502: { description: 'Compression failed due to a malformed summary from the agent.', content: { 'application/json': { schema: ErrorSchema } } },
        500: { description: 'An unexpected error occurred.', content: { 'application/json': { schema: ErrorSchema } } },
    },
});

sessionRoutes.openapi(CompressSessionRoute, async (c) => {
    const { sessionId } = c.req.valid('param');
    const existing = getSessionManager().getSession(sessionId);
    if (!existing) {
        return c.json({ error: 'Session not found' }, 404);
    }
    try {
        const success = await getSessionManager().compressHistory(sessionId);
        if (success) {
            const updatedSession = getSessionManager().getSession(sessionId);
            if (updatedSession) {
                return c.json(updatedSession, 200);
            }
            return c.json({ error: 'Session not found after compression' }, 404);
        }
        return c.json({ error: 'Compression failed; the resulting history was not smaller.' }, 409);
    } catch (err) {
        if (err instanceof Error && err.message?.includes('malformed')) {
            return c.json({ error: err.message }, 502);
        }
        logger.error({ err, sessionId }, 'Failed to compress session history');
        return c.json({ error: 'An unexpected error occurred during compression.' }, 500);
    }
});
