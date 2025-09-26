import { vi } from 'vitest';
import * as os from 'os';

vi.mock('os', async () => {
  const actualOs = await vi.importActual('os') as typeof os;
  return {
    ...actualOs,
    homedir: () => '/tmp/test-home',
  };
});
