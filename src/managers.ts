import { SessionManager } from './session';
import { WorkspaceManager } from './workspaces';

let workspaceManager: WorkspaceManager | null = null;
let sessionManager: SessionManager | null = null;

export function initializeManagers(baseDir?: string): void {
    workspaceManager = new WorkspaceManager(baseDir);
    sessionManager = new SessionManager(workspaceManager);
}

export function getWorkspaceManager(): WorkspaceManager {
    if (!workspaceManager) {
        throw new Error('WorkspaceManager not initialized');
    }
    return workspaceManager;
}

export function getSessionManager(): SessionManager {
    if (!sessionManager) {
        throw new Error('SessionManager not initialized');
    }
    return sessionManager;
}

export { SessionManager, WorkspaceManager };
