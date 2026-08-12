import React, { useState, useEffect } from 'react';
import { User, Project, TreeNode } from '../../types';
import Sidebar from '../Sidebar/Sidebar';
import Editor from '../Editor/Editor';
import Toolbar from '../Toolbar/Toolbar';
import Output from '../Output/Output';
import Terminal from '../Terminal/Terminal';
import Preview from '../Preview/Preview';
import { api, getCapabilities, type Capabilities } from '../../api';

export default function IDE({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [project, setProject] = useState<Project | null>(null);
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [openFiles, setOpenFiles] = useState<{path: string, content: string, dirty: boolean}[]>([]);
  
  const [bottomTab, setBottomTab] = useState<'output' | 'terminal' | 'preview'>('output');

  const fetchProjects = async () => {
    const res = await api<{ projects: Project[] }>('/api/projects');
    setProjects(res.projects);
    if (!project && res.projects.length > 0) setProject(res.projects[0]);
  };

  useEffect(() => { 
    fetchProjects(); 
    getCapabilities().then(setCapabilities).catch(console.error);
  }, []);

  useEffect(() => {
    if (!project) {
      setTree([]);
      setOpenFiles([]);
      setActiveFile(null);
      return;
    }
    api<{ tree: TreeNode[] }>(`/api/projects/${project.id}/tree`).then(r => setTree(r.tree));
  }, [project]);

  useEffect(() => {
    if (openFiles.length === 0) {
      if (activeFile !== null) setActiveFile(null);
    } else if (!activeFile || !openFiles.some((f) => f.path === activeFile)) {
      setActiveFile(openFiles[openFiles.length - 1].path);
    }
  }, [openFiles, activeFile]);

  const handleOpenFile = async (path: string) => {
    if (!project) return;
    if (!openFiles.find(f => f.path === path)) {
      const res = await api<{ content: string }>(`/api/projects/${project.id}/file?path=${encodeURIComponent(path)}`);
      setOpenFiles(prev => [...prev, { path, content: res.content, dirty: false }]);
    }
    setActiveFile(path);
  };

  useEffect(() => {
    const handleSave = async (e: Event) => {
      const { path, content } = (e as CustomEvent).detail;
      if (!project) return;
      try {
        await api(`/api/projects/${project.id}/file`, { 
          method: 'POST', 
          body: JSON.stringify({ path, content }) 
        });
        setOpenFiles(prev => prev.map(f => f.path === path ? { ...f, dirty: false } : f));
      } catch (err) {
        console.error('Failed to save file', err);
      }
    };

    const handleRun = async (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!project) return;
      
      if (detail.activeFile) {
        const file = openFiles.find(f => f.path === detail.activeFile);
        if (file && file.dirty) {
          try {
            await api(`/api/projects/${project.id}/file`, { 
              method: 'POST', 
              body: JSON.stringify({ path: detail.activeFile, content: file.content }) 
            });
            setOpenFiles(prev => prev.map(f => f.path === detail.activeFile ? { ...f, dirty: false } : f));
          } catch (err) {
            console.error('Failed to save file before run', err);
          }
        }
      }
      
      document.dispatchEvent(new CustomEvent('ide-run-confirmed', { detail }));
    };

    document.addEventListener('ide-save', handleSave);
    document.addEventListener('ide-run', handleRun);
    return () => {
      document.removeEventListener('ide-save', handleSave);
      document.removeEventListener('ide-run', handleRun);
    };
  }, [project, openFiles]);

  return (
    <div className="ide-layout">
      <Sidebar 
        user={user} 
        projects={projects} 
        project={project} 
        onSelectProject={setProject}
        onCreateProject={fetchProjects}
        tree={tree}
        onOpenFile={handleOpenFile}
        activeFile={activeFile}
        onLogout={onLogout}
        refreshTree={() => {
          if (project) api<{ tree: TreeNode[] }>(`/api/projects/${project.id}/tree`).then(r => setTree(r.tree));
        }}
      />
      <div className="ide-main">
        <Toolbar project={project} activeFile={activeFile} capabilities={capabilities} />
        <div className="ide-workspace">
          <div className="ide-editor-area">
            <Editor 
              project={project}
              openFiles={openFiles}
              setOpenFiles={setOpenFiles}
              activeFile={activeFile}
              setActiveFile={setActiveFile}
            />
            <div className="ide-bottom-panel">
              <div className="panel-tabs">
                <div className={`panel-tab ${bottomTab === 'output' ? 'active' : ''}`} onClick={() => setBottomTab('output')}>Output</div>
                <div className={`panel-tab ${bottomTab === 'terminal' ? 'active' : ''}`} onClick={() => setBottomTab('terminal')}>Terminal</div>
                <div className={`panel-tab ${bottomTab === 'preview' ? 'active' : ''}`} onClick={() => setBottomTab('preview')}>Web Preview</div>
              </div>
              <div style={{ display: bottomTab === 'output' ? 'block' : 'none', flex: 1, overflow: 'hidden' }}>
                <Output project={project} />
              </div>
              <div style={{ display: bottomTab === 'terminal' ? 'block' : 'none', flex: 1, overflow: 'hidden' }}>
                {project && bottomTab === 'terminal' && <Terminal project={project} />}
              </div>
              <div style={{ display: bottomTab === 'preview' ? 'block' : 'none', flex: 1, overflow: 'hidden' }}>
                {project && bottomTab === 'preview' && <Preview project={project} />}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
