import { vi } from 'vitest';

vi.mock('os', async () => {
    const actualOs = await vi.importActual('os');
    return {
        ...actualOs,
        homedir: () => '/tmp/test-home',
    };
});
