import React from 'react';
import { CollaboratorPresence, CollabConnectionStatus } from '../../collab/client';
import { IconUsers } from '../common/Icons';

export interface CollaboratorAvatarStackProps {
  collaborators: CollaboratorPresence[];
  status: CollabConnectionStatus;
  currentUserId: number;
  onFollowCollaborator?: (collaborator: CollaboratorPresence) => void;
  onOpenShareModal?: () => void;
}

export default function CollaboratorAvatarStack({
  collaborators,
  status,
  currentUserId,
  onFollowCollaborator,
  onOpenShareModal,
}: CollaboratorAvatarStackProps) {
  const otherCollaborators = collaborators.filter((c) => c.userId !== currentUserId);

  const getStatusBadge = () => {
    switch (status) {
      case 'connected':
        return (
          <span
            className="collab-status-badge synced"
            title="Real-Time CRDT Synchronization Active"
            aria-label="Real-Time Synchronization Active"
          >
            <span className="status-dot green" />
            <span className="status-label">Synced</span>
          </span>
        );
      case 'connecting':
      case 'reconnecting':
        return (
          <span
            className="collab-status-badge reconnecting"
            title="Reconnecting to Collaboration Room..."
            aria-label="Reconnecting..."
          >
            <span className="status-dot amber pulse" />
            <span className="status-label">Reconnecting…</span>
          </span>
        );
      case 'resynchronizing':
        return (
          <span
            className="collab-status-badge resyncing"
            title="Resynchronizing CRDT Deltas..."
            aria-label="Resynchronizing..."
          >
            <span className="status-dot cyan pulse" />
            <span className="status-label">Resyncing…</span>
          </span>
        );
      case 'forbidden':
        return (
          <span
            className="collab-status-badge error"
            title="Collaboration Access Revoked / Forbidden"
            aria-label="Access Forbidden"
          >
            <span className="status-dot red" />
            <span className="status-label">Access Revoked</span>
          </span>
        );
      default:
        return (
          <span
            className="collab-status-badge offline"
            title="Offline / Disconnected"
            aria-label="Offline"
          >
            <span className="status-dot gray" />
            <span className="status-label">Offline</span>
          </span>
        );
    }
  };

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        fontSize: '11px',
      }}
      role="region"
      aria-label="Collaborator Presence & Sync Status"
    >
      {/* Sync Status Badge */}
      {getStatusBadge()}

      {/* Collaborator Avatars Stack */}
      {otherCollaborators.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', marginLeft: '4px' }}>
          {otherCollaborators.map((c) => {
            const initials = c.name.slice(0, 2).toUpperCase();
            return (
              <button
                key={c.clientId}
                onClick={() => onFollowCollaborator?.(c)}
                style={{
                  width: '24px',
                  height: '24px',
                  borderRadius: '50%',
                  background: c.color,
                  color: '#11131c',
                  fontWeight: 700,
                  fontSize: '10px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  border: '2px solid rgba(17, 19, 28, 0.9)',
                  marginLeft: '-6px',
                  cursor: 'pointer',
                  padding: 0,
                  transition: 'transform 120ms ease',
                  boxShadow: '0 2px 6px rgba(0,0,0,0.3)',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.transform = 'translateY(-2px) scale(1.1)')}
                onMouseLeave={(e) => (e.currentTarget.style.transform = 'translateY(0) scale(1)')}
                title={`${c.name} (${c.role.toUpperCase()}) ${
                  c.activeFile ? `• Editing ${c.activeFile}` : ''
                } — Click to Follow`}
                aria-label={`Collaborator ${c.name}, ${c.role}. Click to follow.`}
              >
                {initials}
              </button>
            );
          })}
        </div>
      )}

      {/* Share / Invite Trigger Button */}
      {onOpenShareModal && (
        <button
          className="glass-btn"
          onClick={onOpenShareModal}
          style={{
            padding: '4px 10px',
            fontSize: '11px',
            background: 'rgba(137, 180, 250, 0.1)',
            color: '#89b4fa',
            border: '1px solid rgba(137, 180, 250, 0.3)',
            display: 'flex',
            alignItems: 'center',
            gap: '5px',
          }}
          title="Share Project & Manage Collaborators"
        >
          <IconUsers size={12} />
          <span>Share</span>
        </button>
      )}
    </div>
  );
}
