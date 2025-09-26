import { z } from 'zod';

export const SessionIdSchema = z.string().openapi({
    param: {
        name: 'sessionId',
        in: 'path',
    },
    example: 'a1b2c3d4-e5f6-7890-1234-567890abcdef',
});

export const ErrorSchema = z.object({
    error: z.string(),
});
