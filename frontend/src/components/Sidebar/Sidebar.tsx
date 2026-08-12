import React, { useState, useEffect, useRef } from 'react';
import { User, Project, TreeNode } from '../../types';
import { api } from '../../api';

export default function Sidebar({ user, projects, project, onSelectProject, onCreateProject, tree, onOpenFile, activeFile, onLogout, refreshTree }: any) {
  const [newProjName, setNewProjName] = useState('');

  const handleCreate = async () => {
    if (!newProjName.trim()) return;
    await api('/api/projects', { method: 'POST', body: JSON.stringify({ name: newProjName, language: 'auto' }) });
    setNewProjName('');
    onCreateProject();
  };

  const handleFileAction = async (action: string, node?: TreeNode | null) => {
    if (!project) return;
    const parentPath = node?.type === 'dir' ? node.path : (node ? node.path.split('/').slice(0, -1).join('/') : '');
    
    try {
      if (action === 'new_file') {
        const name = prompt('File name:');
        if (!name) return;
        const fullPath = parentPath ? `${parentPath}/${name}` : name;
        await api(`/api/projects/${project.id}/file`, { method: 'POST', body: JSON.stringify({ path: fullPath, content: '' }) });
        refreshTree();
        onOpenFile(fullPath);
      } else if (action === 'new_folder') {
        const name = prompt('Folder name:');
        if (!name) return;
        const fullPath = parentPath ? `${parentPath}/${name}/.keep` : `${name}/.keep`;
        await api(`/api/projects/${project.id}/file`, { method: 'POST', body: JSON.stringify({ path: fullPath, content: '' }) });
        refreshTree();
      } else if (action === 'rename' && node) {
        const name = prompt('New name:', node.name);
        if (!name || name === node.name) return;
        const newPath = parentPath ? `${parentPath}/${name}` : name;
        await api(`/api/projects/${project.id}/move`, { method: 'POST', body: JSON.stringify({ from: node.path, to: newPath }) });
        refreshTree();
        if (activeFile === node.path) onOpenFile(newPath);
      } else if (action === 'delete' && node) {
        if (!confirm(`Delete ${node.name}?`)) return;
        await api(`/api/projects/${project.id}/delete`, { method: 'POST', body: JSON.stringify({ path: node.path }) });
        refreshTree();
      }
    } catch (err: any) {
      alert(`Error: ${err.message || 'Action failed'}`);
    }
  };

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <span>{user.username}</span>
        <button className="link" onClick={onLogout}>Logout</button>
      </div>
      <div className="sidebar-content">
        <div className="projects-section">
          <div className="section-header">Projects</div>
          <div style={{ padding: '0 12px 8px', display: 'flex', gap: '4px' }}>
            <input value={newProjName} onChange={e => setNewProjName(e.target.value)} placeholder="New project..." style={{flex:1, minWidth:0}} />
            <button onClick={handleCreate}>+</button>
          </div>
          <ul className="project-list">
            {projects.map((p: Project) => (
              <li key={p.id} className={`project-item ${project?.id === p.id ? 'active' : ''}`} onClick={() => onSelectProject(p)}>
                {p.name}
              </li>
            ))}
          </ul>
        </div>
        {project && (
          <div className="explorer-section" style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
            <div className="section-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              Explorer
              <div style={{ display: 'flex', gap: '4px' }}>
                <button onClick={() => handleFileAction('new_file')} title="New File" style={{ padding: '2px 6px', fontSize: '10px' }}>📄+</button>
                <button onClick={() => handleFileAction('new_folder')} title="New Folder" style={{ padding: '2px 6px', fontSize: '10px' }}>📁+</button>
                <button onClick={refreshTree} title="Refresh" style={{ padding: '2px 6px', fontSize: '10px' }}>↻</button>
              </div>
            </div>
            <div style={{ padding: '0 12px', flex: 1, overflow: 'auto' }} className="file-tree-container">
              <FileTree 
                nodes={tree} 
                onSelect={onOpenFile} 
                selected={activeFile} 
                onAction={handleFileAction}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function FileTree({ nodes, onSelect, selected, onAction }: any) {
  const [contextMenu, setContextMenu] = useState<{x: number, y: number, node: TreeNode | null, type: 'bg' | 'node'} | null>(null);
  
  const handleContextBg = (e: React.MouseEvent) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, node: null, type: 'bg' });
  };
  
  const handleContextNode = (e: React.MouseEvent, node: TreeNode) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, node, type: 'node' });
  };

  useEffect(() => {
    const closeMenu = () => setContextMenu(null);
    document.addEventListener('click', closeMenu);
    return () => document.removeEventListener('click', closeMenu);
  }, []);

  return (
    <div onContextMenu={handleContextBg} style={{ minHeight: '100%', paddingBottom: '20px' }}>
      {nodes.length === 0 ? (
        <div style={{ padding: '24px 12px', textAlign: 'center', color: 'var(--muted)', fontSize: '12px' }}>
          <p style={{ margin: '0 0 12px 0' }}>Project is empty</p>
          <div style={{ display: 'flex', gap: '8px', justifyContent: 'center' }}>
            <button onClick={() => onAction('new_file')} style={{ padding: '4px 8px', fontSize: '11px', background: 'var(--panel-2)', border: '1px solid var(--border)', color: 'var(--fg)', borderRadius: '4px' }}>New File</button>
            <button onClick={() => onAction('new_folder')} style={{ padding: '4px 8px', fontSize: '11px', background: 'var(--panel-2)', border: '1px solid var(--border)', color: 'var(--fg)', borderRadius: '4px' }}>New Folder</button>
          </div>
        </div>
      ) : (
        <FileTreeNodes nodes={nodes} onSelect={onSelect} selected={selected} onContextNode={handleContextNode} />
      )}
      
      {contextMenu && (
        <div style={{
          position: 'fixed',
          top: contextMenu.y,
          left: contextMenu.x,
          background: 'var(--panel)',
          border: '1px solid var(--border)',
          borderRadius: '6px',
          padding: '4px 0',
          zIndex: 1000,
          boxShadow: '0 8px 16px rgba(0,0,0,0.4)',
          minWidth: '140px'
        }}>
          <div className="menu-item" onClick={() => onAction('new_file', contextMenu.node)}>New File</div>
          <div className="menu-item" onClick={() => onAction('new_folder', contextMenu.node)}>New Folder</div>
          {contextMenu.type === 'node' && (
            <>
              <div style={{ height: '1px', background: '#444', margin: '4px 0' }} />
              <div className="menu-item" onClick={() => onAction('rename', contextMenu.node)}>Rename</div>
              <div className="menu-item" onClick={() => onAction('delete', contextMenu.node)} style={{ color: '#ff6b6b' }}>Delete</div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function FileTreeNodes({ nodes, onSelect, selected, onContextNode }: any) {
  return (
    <ul className="file-tree">
      {nodes.map((n: TreeNode) => (
        <li key={n.path}>
          <div 
            className={`tree-node ${selected === n.path ? 'active' : ''}`}
            onClick={() => n.type === 'file' && onSelect(n.path)}
            onContextMenu={(e) => onContextNode(e, n)}
          >
            <span style={{opacity: 0.7}}>{n.type === 'dir' ? '📁' : '📄'}</span>
            {n.name}
          </div>
          {n.children && (
            <div className="tree-children">
              <FileTreeNodes nodes={n.children} onSelect={onSelect} selected={selected} onContextNode={onContextNode} />
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}
