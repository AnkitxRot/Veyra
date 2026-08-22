import React, { useState, useEffect, useCallback } from 'react';
import { IconClose, IconUsers, IconTrash, IconCheck } from '../common/Icons';

export interface CollaboratorItem {
  userId: number;
  username: string;
  role: 'owner' | 'editor' | 'viewer';
  createdAt: string;
}

export interface ProjectSharingModalProps {
  projectId: string;
  projectName: string;
  isOpen: boolean;
  onClose: () => void;
  currentUserRole: 'owner' | 'editor' | 'viewer';
}

export default function ProjectSharingModal({
  projectId,
  projectName,
  isOpen,
  onClose,
  currentUserRole,
}: ProjectSharingModalProps) {
  const [collaborators, setCollaborators] = useState<CollaboratorItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inviteUsername, setInviteUsername] = useState('');
  const [inviteRole, setInviteRole] = useState<'editor' | 'viewer'>('editor');
  const [inviting, setInviting] = useState(false);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const fetchCollaborators = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/collaborators`, { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to load project collaborators');
      const data = await res.json();
      setCollaborators(data.collaborators || []);
    } catch (err: any) {
      setError(err.message || 'Failed to fetch collaborators');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    if (isOpen) {
      fetchCollaborators();
      setSuccessMsg(null);
      setError(null);
    }
  }, [isOpen, projectId, fetchCollaborators]);

  const handleInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inviteUsername.trim()) return;

    setInviting(true);
    setError(null);
    setSuccessMsg(null);

    try {
      const res = await fetch(`/api/projects/${projectId}/collaborators`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          username: inviteUsername.trim(),
          role: inviteRole,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || 'Failed to invite collaborator');
      }

      setSuccessMsg(`Invited "${inviteUsername}" as ${inviteRole.toUpperCase()}`);
      setInviteUsername('');
      fetchCollaborators();
    } catch (err: any) {
      setError(err.message || 'Failed to invite collaborator');
    } finally {
      setInviting(false);
    }
  };

  const handleRevoke = async (userId: number, username: string) => {
    if (!window.confirm(`Revoke collaboration access for ${username}?`)) return;

    try {
      const res = await fetch(`/api/projects/${projectId}/collaborators/${userId}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) throw new Error('Failed to revoke collaborator');
      setSuccessMsg(`Revoked access for ${username}`);
      fetchCollaborators();
    } catch (err: any) {
      setError(err.message || 'Failed to revoke collaborator');
    }
  };

  const handleRoleChange = async (userId: number, newRole: 'editor' | 'viewer') => {
    try {
      const res = await fetch(`/api/projects/${projectId}/collaborators/${userId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ role: newRole }),
      });
      if (!res.ok) throw new Error('Failed to update collaborator role');
      fetchCollaborators();
    } catch (err: any) {
      setError(err.message || 'Failed to update role');
    }
  };

  if (!isOpen) return null;

  const isOwner = currentUserRole === 'owner';

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(10, 12, 18, 0.75)',
        backdropFilter: 'blur(12px)',
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '16px',
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="collab-modal-title"
    >
      <div
        className="glass-panel"
        style={{
          width: '100%',
          maxWidth: '520px',
          backgroundColor: '#161922',
          border: '1px solid rgba(255, 255, 255, 0.12)',
          borderRadius: '12px',
          boxShadow: '0 24px 48px rgba(0, 0, 0, 0.6)',
          display: 'flex',
          flexDirection: 'column',
          maxHeight: '90vh',
          overflow: 'hidden',
        }}
      >
        {/* Modal Header */}
        <div
          style={{
            padding: '16px 20px',
            borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div
              style={{
                width: '32px',
                height: '32px',
                borderRadius: '8px',
                backgroundColor: 'rgba(137, 180, 250, 0.15)',
                color: '#89b4fa',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <IconUsers size={18} />
            </div>
            <div>
              <h2
                id="collab-modal-title"
                style={{ fontSize: '15px', fontWeight: 600, margin: 0, color: '#cdd6f4' }}
              >
                Share & Collaborate
              </h2>
              <div style={{ fontSize: '12px', color: '#a6adc8' }}>
                Project: <strong>{projectName}</strong>
              </div>
            </div>
          </div>
          <button
            onClick={onClose}
            className="glass-btn icon-only"
            aria-label="Close modal"
            style={{ width: '28px', height: '28px' }}
          >
            <IconClose size={14} />
          </button>
        </div>

        {/* Modal Body */}
        <div style={{ padding: '20px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {error && (
            <div
              style={{
                padding: '10px 14px',
                borderRadius: '6px',
                background: 'rgba(243, 139, 168, 0.15)',
                border: '1px solid rgba(243, 139, 168, 0.3)',
                color: '#f38ba8',
                fontSize: '12px',
              }}
            >
              {error}
            </div>
          )}

          {successMsg && (
            <div
              style={{
                padding: '10px 14px',
                borderRadius: '6px',
                background: 'rgba(166, 227, 161, 0.15)',
                border: '1px solid rgba(166, 227, 161, 0.3)',
                color: '#a6e3a1',
                fontSize: '12px',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
              }}
            >
              <IconCheck size={14} />
              <span>{successMsg}</span>
            </div>
          )}

          {/* Invite Form (Owner only) */}
          {isOwner ? (
            <form onSubmit={handleInvite} style={{ display: 'flex', gap: '8px' }}>
              <input
                type="text"
                placeholder="Enter username to invite..."
                value={inviteUsername}
                onChange={(e) => setInviteUsername(e.target.value)}
                className="glass-input"
                style={{ flex: 1, fontSize: '13px', padding: '8px 12px' }}
                disabled={inviting}
              />
              <select
                value={inviteRole}
                onChange={(e) => setInviteRole(e.target.value as 'editor' | 'viewer')}
                className="glass-select"
                style={{
                  background: '#1e2230',
                  color: '#cdd6f4',
                  border: '1px solid rgba(255, 255, 255, 0.12)',
                  borderRadius: '6px',
                  padding: '8px 10px',
                  fontSize: '12px',
                }}
                disabled={inviting}
              >
                <option value="editor">Editor (Can edit)</option>
                <option value="viewer">Viewer (Read-only)</option>
              </select>
              <button
                type="submit"
                className="glass-btn primary"
                disabled={inviting || !inviteUsername.trim()}
                style={{ padding: '8px 16px', fontSize: '12px', fontWeight: 600 }}
              >
                {inviting ? 'Inviting…' : 'Invite'}
              </button>
            </form>
          ) : (
            <div style={{ fontSize: '12px', color: '#a6adc8', fontStyle: 'italic' }}>
              Only project owners can invite or remove collaborators.
            </div>
          )}

          {/* Members List */}
          <div>
            <div
              style={{
                fontSize: '12px',
                fontWeight: 600,
                color: '#bac2de',
                marginBottom: '8px',
                textTransform: 'uppercase',
                letterSpacing: '0.5px',
              }}
            >
              Active Collaborators ({collaborators.length})
            </div>

            {loading ? (
              <div style={{ fontSize: '12px', color: '#6c7086', padding: '12px 0' }}>Loading members...</div>
            ) : collaborators.length === 0 ? (
              <div
                style={{
                  padding: '16px',
                  background: 'rgba(255, 255, 255, 0.02)',
                  borderRadius: '8px',
                  border: '1px dashed rgba(255, 255, 255, 0.08)',
                  textAlign: 'center',
                  fontSize: '12px',
                  color: '#a6adc8',
                }}
              >
                No external collaborators yet. Invite teammates above for real-time multiplayer coding!
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {collaborators.map((c) => (
                  <div
                    key={c.userId}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '10px 14px',
                      background: 'rgba(255, 255, 255, 0.03)',
                      borderRadius: '8px',
                      border: '1px solid rgba(255, 255, 255, 0.06)',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                      <div
                        style={{
                          width: '28px',
                          height: '28px',
                          borderRadius: '50%',
                          background: 'linear-gradient(135deg, #89b4fa, #cba6f7)',
                          color: '#11131c',
                          fontWeight: 700,
                          fontSize: '11px',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        {c.username.slice(0, 2).toUpperCase()}
                      </div>
                      <div>
                        <div style={{ fontSize: '13px', fontWeight: 600, color: '#cdd6f4' }}>
                          {c.username}
                        </div>
                        <div style={{ fontSize: '11px', color: '#6c7086' }}>
                          Joined {new Date(c.createdAt).toLocaleDateString()}
                        </div>
                      </div>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      {isOwner ? (
                        <>
                          <select
                            value={c.role}
                            onChange={(e) =>
                              handleRoleChange(c.userId, e.target.value as 'editor' | 'viewer')
                            }
                            style={{
                              background: '#1e2230',
                              color: '#cdd6f4',
                              border: '1px solid rgba(255, 255, 255, 0.1)',
                              borderRadius: '4px',
                              padding: '4px 8px',
                              fontSize: '11px',
                            }}
                          >
                            <option value="editor">Editor</option>
                            <option value="viewer">Viewer</option>
                          </select>
                          <button
                            onClick={() => handleRevoke(c.userId, c.username)}
                            className="glass-btn icon-only"
                            style={{ color: '#f38ba8', width: '26px', height: '26px' }}
                            title={`Revoke access for ${c.username}`}
                            aria-label={`Revoke access for ${c.username}`}
                          >
                            <IconTrash size={12} />
                          </button>
                        </>
                      ) : (
                        <span
                          style={{
                            fontSize: '11px',
                            padding: '3px 8px',
                            borderRadius: '12px',
                            background: 'rgba(255, 255, 255, 0.08)',
                            color: '#cdd6f4',
                            textTransform: 'uppercase',
                          }}
                        >
                          {c.role}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div
          style={{
            padding: '12px 20px',
            borderTop: '1px solid rgba(255, 255, 255, 0.08)',
            display: 'flex',
            justifyContent: 'flex-end',
          }}
        >
          <button onClick={onClose} className="glass-btn" style={{ padding: '6px 16px', fontSize: '12px' }}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
