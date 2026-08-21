/**
 * Client-side persistence store for tracking Recent Files and Recent Projects.
 */

const MAX_RECENT_ITEMS = 20;

export interface RecentProject {
  id: string;
  name: string;
  language?: string;
  lastOpened: number;
}

export function getRecentFiles(projectId: string): string[] {
  if (!projectId) return [];
  try {
    const raw = localStorage.getItem(`cloudeee_recent_files_${projectId}`);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function addRecentFile(projectId: string, filePath: string): void {
  if (!projectId || !filePath) return;
  try {
    const current = getRecentFiles(projectId);
    const filtered = current.filter((p) => p !== filePath);
    const updated = [filePath, ...filtered].slice(0, MAX_RECENT_ITEMS);
    localStorage.setItem(`cloudeee_recent_files_${projectId}`, JSON.stringify(updated));
  } catch {}
}

export function getRecentProjects(): RecentProject[] {
  try {
    const raw = localStorage.getItem('cloudeee_recent_projects');
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function addRecentProject(project: { id: string; name: string; language?: string }): void {
  if (!project || !project.id) return;
  try {
    const current = getRecentProjects();
    const filtered = current.filter((p) => p.id !== project.id);
    const updated: RecentProject[] = [
      {
        id: project.id,
        name: project.name,
        language: project.language,
        lastOpened: Date.now(),
      },
      ...filtered,
    ].slice(0, MAX_RECENT_ITEMS);
    localStorage.setItem('cloudeee_recent_projects', JSON.stringify(updated));
  } catch {}
}
