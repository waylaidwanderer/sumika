import { promises as fs } from 'fs';
import * as path from 'path';
import { SettingsSchema, type Settings } from '@waylaidwanderer/sumika-types';
import { logger } from './logger';

const SETTINGS_FILENAME = 'settings.json';

export async function loadSettings(sumikaDir: string): Promise<Settings> {
    const filePath = path.join(sumikaDir, SETTINGS_FILENAME);
    try {
        const data = await fs.readFile(filePath, 'utf-8');
        const parseResult = SettingsSchema.safeParse(JSON.parse(data));
        if (parseResult.success) {
            return parseResult.data;
        }
        logger.error({ err: parseResult.error }, 'Error parsing settings.json');
        throw new Error('Failed to parse settings.json');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return { env: {}, mcpServers: {} };
        }
        logger.error({ err: error }, 'Corrupt settings.json found, backing it up and starting fresh.');
        try {
            await fs.rename(filePath, `${filePath}.bak`);
        } catch (backupError) {
            logger.error({ err: backupError }, 'Failed to create backup of corrupt settings.json.');
        }
        return { env: {}, mcpServers: {} };
    }
}

export async function saveSettings(sumikaDir: string, settings: Settings): Promise<void> {
    const dir = sumikaDir;
    await fs.mkdir(dir, { recursive: true });
    const tempFilePath = path.join(dir, `${SETTINGS_FILENAME}.tmp`);
    try {
        const validatedSettings = SettingsSchema.parse(settings);
        await fs.writeFile(tempFilePath, JSON.stringify(validatedSettings, null, 2), 'utf-8');
        await fs.rename(tempFilePath, path.join(dir, SETTINGS_FILENAME));
    } catch (error) {
        try {
            await fs.unlink(tempFilePath);
        } catch {
            // Ignore cleanup errors
        }
    }
}
