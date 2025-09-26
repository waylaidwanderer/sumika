import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Workspace, McpServer, WorkspaceSchema } from '@waylaidwanderer/sumika-types';
import { logger } from './logger';

export class WorkspaceManager {
    private SUMIKA_DIR: string;
    private WORKSPACES_DIR: string;
    private SESSIONS_DIR: string;
    private WORKSPACES_METADATA_FILE: string;
    private workspaces: Map<string, Workspace> = new Map();

  constructor(baseDir?: string) {
      const home = baseDir || os.homedir();
      this.SUMIKA_DIR = path.join(home, '.sumika');
      this.WORKSPACES_DIR = path.join(this.SUMIKA_DIR, 'workspaces');
      this.SESSIONS_DIR = path.join(this.SUMIKA_DIR, 'sessions');
      this.WORKSPACES_METADATA_FILE = path.join(this.SUMIKA_DIR, 'workspaces.json');
  }

  public get sumikaDir(): string {
    return this.SUMIKA_DIR;
  }

  public async initialize() {
    await this.ensureDirectories();
    await this.loadWorkspaces();
  }

  public async ensureDirectories() {
    try {
      await fs.mkdir(this.SUMIKA_DIR, { recursive: true });
      await fs.mkdir(this.WORKSPACES_DIR, { recursive: true });
      await fs.mkdir(this.SESSIONS_DIR, { recursive: true });
      logger.info({ sumikaDir: this.SUMIKA_DIR }, `Sumika directories ensured`);
    } catch (error) {
      logger.error({ err: error }, 'Error ensuring Sumika directories');
      throw new Error('Failed to create necessary Sumika directories.');
    }
  }

  public async loadWorkspaces() {
    this.workspaces.clear();
    try {
      const data = await fs.readFile(this.WORKSPACES_METADATA_FILE, 'utf-8');
      const parseResult = WorkspaceSchema.array().safeParse(JSON.parse(data));
      if (parseResult.success) {
        this.workspaces = new Map(parseResult.data.map(w => [w.id, w]));
      } else {
        logger.error({ err: parseResult.error }, 'Error parsing workspaces.json');
        throw new Error('Failed to parse workspaces.json');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.workspaces = new Map();
      } else {
        logger.error({ err: error }, 'Error parsing workspaces.json, backing it up and starting fresh.');
        try {
          await fs.rename(this.WORKSPACES_METADATA_FILE, `${this.WORKSPACES_METADATA_FILE}.bak`);
        } catch (backupError) {
          logger.error({ err: backupError }, 'Failed to create backup of corrupt workspaces.json.');
        }
        this.workspaces = new Map();
      }
    }

    await this.reconcileWorkspacesWithFileSystem();

    if (this.workspaces.size === 0) {
        logger.info('No workspaces found, creating default workspace.');
        await this.createWorkspace('Default Workspace', 'A workspace for general tasks.');
    }
  }

  private async reconcileWorkspacesWithFileSystem() {
    try {
      const dirents = await fs.readdir(this.WORKSPACES_DIR, { withFileTypes: true });
      const existingManagedDirs = new Set(dirents.filter(d => d.isDirectory()).map(d => d.name));
      
      const workspacesToDelete: string[] = [];

      for (const workspaceId of this.workspaces.keys()) {
        const workspace = this.workspaces.get(workspaceId)!;
        const isManaged = workspace.path.startsWith(this.WORKSPACES_DIR);

        if (isManaged) {
          if (!existingManagedDirs.has(workspaceId)) {
            logger.warn({ workspaceName: workspace.name, workspaceId }, `Managed workspace metadata found, but directory is missing. Removing.`);
            workspacesToDelete.push(workspaceId);
          }
        } else {
          try {
            const stats = await fs.stat(workspace.path);
            if (!stats.isDirectory()) {
              logger.warn({ workspaceName: workspace.name, workspaceId, path: workspace.path }, `Custom workspace path exists but is not a directory. Removing.`);
              workspacesToDelete.push(workspaceId);
            }
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
              logger.warn({ workspaceName: workspace.name, workspaceId, path: workspace.path }, `Custom workspace path not found. Removing.`);
              workspacesToDelete.push(workspaceId);
            } else {
              logger.error({ err: error, workspaceName: workspace.name, workspaceId }, `Error checking custom workspace path`);
            }
          }
        }
      }

      if (workspacesToDelete.length > 0) {
        for (const workspaceId of workspacesToDelete) {
          await this.deleteWorkspace(workspaceId, false);
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.error({ err: error }, 'Error reconciling workspaces with file system');
      }
    }
  }

  private async _saveWorkspaces() {
    const workspacesData = Array.from(this.workspaces.values());
    const tempFilePath = `${this.WORKSPACES_METADATA_FILE}.tmp`;
    try {
        await fs.writeFile(tempFilePath, JSON.stringify(workspacesData, null, 2), 'utf-8');
        await fs.rename(tempFilePath, this.WORKSPACES_METADATA_FILE);
    } catch (error) {
        logger.error({ err: error }, 'Error saving workspaces metadata');
        try {
            await fs.unlink(tempFilePath);
        } catch {
            // Ignore cleanup errors
        }
    }
  }

  public async createWorkspace(name: string, description?: string, customPath?: string): Promise<Workspace> {
    const id = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    if (this.workspaces.has(id)) {
      return this.createWorkspace(`${name}-${Date.now()}`, description, customPath);
    }

    let workspacePath: string;

    if (customPath) {
      for (const ws of this.workspaces.values()) {
        if (ws.path === customPath) {
          throw new Error(`Path is already in use by another workspace: ${ws.name}`);
        }
      }
      try {
        const stats = await fs.stat(customPath);
        if (!stats.isDirectory()) {
          throw new Error(`Provided path is not a directory: ${customPath}`);
        }
        workspacePath = customPath;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new Error(`Provided path does not exist: ${customPath}`);
        }
        throw new Error(`Invalid path provided. Please ensure it's an absolute path to an existing directory.`);
      }
    } else {
      workspacePath = path.join(this.WORKSPACES_DIR, id);
      await fs.mkdir(workspacePath, { recursive: true });
    }

    const newWorkspace: Workspace = {
      id,
      name,
      description: description || '',
      path: workspacePath,
      createdAt: new Date().toISOString(),
      pinned: false,
      env: {},
      mcpServers: {},
    };

    this.workspaces.set(id, newWorkspace);
    await this._saveWorkspaces();
    return newWorkspace;
  }

  public async isWorkspaceEmpty(id: string): Promise<boolean> {
    const workspace = this.workspaces.get(id);
    if (!workspace) {
      throw new Error(`Workspace with ID ${id} not found.`);
    }

    const ignoredFiles = new Set(['.DS_Store', 'Thumbs.db']);
    const files = await fs.readdir(workspace.path);
    const userFiles = files.filter(file => !ignoredFiles.has(file));

    return userFiles.length === 0;
  }

  public getWorkspace(id: string): Workspace | undefined {
    return this.workspaces.get(id);
  }

  public getAllWorkspaces(): Workspace[] {
    return Array.from(this.workspaces.values());
  }

  public async updateWorkspace(id: string, updates: { name?: string; description?: string; pinned?: boolean; env?: Record<string, string>, mcpServers?: Record<string, McpServer> }): Promise<Workspace | undefined> {
    const workspace = this.workspaces.get(id);
    if (!workspace) {
      return undefined;
    }

    if (updates.name) {
      workspace.name = updates.name;
    }
    if (updates.description) {
      workspace.description = updates.description;
    }
    if (updates.pinned !== undefined) {
        workspace.pinned = updates.pinned;
    }
    if (updates.env) {
      workspace.env = updates.env;
    }
    if (updates.mcpServers) {
      workspace.mcpServers = updates.mcpServers;
    }

    this.workspaces.set(id, workspace);
    await this._saveWorkspaces();
    return workspace;
  }

  public async deleteWorkspace(id: string, deleteFiles: boolean): Promise<boolean> {
    const workspace = this.workspaces.get(id);
    if (!workspace) {
      return false;
    }

    const isManagedWorkspace = workspace.path.startsWith(this.WORKSPACES_DIR);
    if (deleteFiles && !isManagedWorkspace) {
      throw new Error('Cannot delete files for a custom-path workspace.');
    }

    const sessionDir = path.join(this.SESSIONS_DIR, id);
    await fs.rm(sessionDir, { recursive: true, force: true });

    if (deleteFiles && isManagedWorkspace) {
      await fs.rm(workspace.path, { recursive: true, force: true });
    }

    this.workspaces.delete(id);
    await this._saveWorkspaces();
    return true;
  }

  public clear() {
    this.workspaces.clear();
  }
}
