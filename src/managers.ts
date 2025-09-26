import { WorkspaceManager } from './workspaces';
import { SessionManager } from './session';

export let workspaceManager: WorkspaceManager;
export let sessionManager: SessionManager;

export function initializeManagers(baseDir?: string) {
    workspaceManager = new WorkspaceManager(baseDir);
    sessionManager = new SessionManager(workspaceManager);
}

export { WorkspaceManager, SessionManager };
