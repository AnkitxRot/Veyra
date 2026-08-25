import React, { useState, useEffect } from 'react';
import { UserPreferences } from '../../types';
import { IconClose, IconSettings, IconRefresh } from '../common/Icons';

export const DEFAULT_PREFERENCES: UserPreferences = {
  fontSize: 13.5,
  tabSize: 4,
  wordWrap: 'off',
  minimap: false,
  lineNumbers: 'on',
  cursorBlinking: 'smooth',
  renderWhitespace: 'selection',
};

interface SettingsModalProps {
  isOpen: boolean;
  preferences: UserPreferences;
  onSave: (updated: Partial<UserPreferences>) => Promise<void>;
  onClose: () => void;
}

export default function SettingsModal({
  isOpen,
  preferences,
  onSave,
  onClose,
}: SettingsModalProps) {
  const [formData, setFormData] = useState<UserPreferences>(preferences);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setFormData(preferences);
      setError(null);
    }
  }, [isOpen, preferences]);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await onSave(formData);
      onClose();
    } catch (err: any) {
      setError(err.message || 'Failed to save preferences');
    } finally {
      setSaving(false);
    }
  };

  const handleResetDefaults = () => {
    setFormData(DEFAULT_PREFERENCES);
  };

  return (
    <div
      className="modal-backdrop"
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.65)',
        backdropFilter: 'blur(6px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 9999,
        padding: '20px',
      }}
      onClick={onClose}
    >
      <div
        className="modal-content glass-panel"
        style={{
          width: '100%',
          maxWidth: '520px',
          backgroundColor: 'var(--surface-0)',
          borderRadius: '12px',
          border: '1px solid var(--border)',
          boxShadow: '0 20px 40px rgba(0,0,0,0.4)',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          maxHeight: '90vh',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '16px 20px',
            borderBottom: '1px solid var(--border)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <IconSettings size={18} color="var(--accent)" />
            <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 600 }}>
              Editor Preferences
            </h3>
          </div>
          <button
            className="glass-btn glass-btn-icon"
            onClick={onClose}
            aria-label="Close"
          >
            <IconClose size={14} />
          </button>
        </div>

        {/* Form Body */}
        <form
          onSubmit={handleSubmit}
          style={{
            padding: '20px',
            display: 'flex',
            flexDirection: 'column',
            gap: '16px',
            overflowY: 'auto',
          }}
        >
          {error && (
            <div
              style={{
                padding: '10px 14px',
                borderRadius: '6px',
                backgroundColor: 'rgba(243, 139, 168, 0.15)',
                border: '1px solid rgba(243, 139, 168, 0.3)',
                color: '#f38ba8',
                fontSize: '13px',
              }}
            >
              {error}
            </div>
          )}

          {/* Font Size */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <label
              style={{
                fontSize: '12px',
                fontWeight: 500,
                color: 'var(--text-muted)',
              }}
            >
              Font Size: <strong style={{ color: 'var(--text)' }}>{formData.fontSize}px</strong>
            </label>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <input
                type="range"
                min="8"
                max="32"
                step="0.5"
                value={formData.fontSize}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    fontSize: parseFloat(e.target.value),
                  })
                }
                style={{ flex: 1 }}
              />
              <input
                type="number"
                min="8"
                max="32"
                step="0.5"
                className="glass-input"
                style={{ width: '70px', padding: '4px 8px', fontSize: '12px' }}
                value={formData.fontSize}
                onChange={(e) => {
                  const val = parseFloat(e.target.value);
                  if (!isNaN(val)) setFormData({ ...formData, fontSize: val });
                }}
              />
            </div>
          </div>

          {/* Tab Size */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <label
              style={{
                fontSize: '12px',
                fontWeight: 500,
                color: 'var(--text-muted)',
              }}
            >
              Tab Size (Spaces)
            </label>
            <select
              className="glass-input"
              style={{ padding: '6px 10px', fontSize: '13px' }}
              value={formData.tabSize}
              onChange={(e) =>
                setFormData({
                  ...formData,
                  tabSize: parseInt(e.target.value, 10) as any,
                })
              }
            >
              <option value="2">2 Spaces</option>
              <option value="4">4 Spaces (Default)</option>
              <option value="8">8 Spaces</option>
            </select>
          </div>

          {/* Word Wrap */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <label
              style={{
                fontSize: '12px',
                fontWeight: 500,
                color: 'var(--text-muted)',
              }}
            >
              Word Wrap
            </label>
            <select
              className="glass-input"
              style={{ padding: '6px 10px', fontSize: '13px' }}
              value={formData.wordWrap}
              onChange={(e) =>
                setFormData({
                  ...formData,
                  wordWrap: e.target.value as any,
                })
              }
            >
              <option value="off">Off (No wrapping)</option>
              <option value="on">On (Wrap at viewport width)</option>
              <option value="wordWrapColumn">Wrap at 80 Columns</option>
              <option value="bounded">Bounded (Viewport & 80 Columns)</option>
            </select>
          </div>

          {/* Line Numbers */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <label
              style={{
                fontSize: '12px',
                fontWeight: 500,
                color: 'var(--text-muted)',
              }}
            >
              Line Numbers
            </label>
            <select
              className="glass-input"
              style={{ padding: '6px 10px', fontSize: '13px' }}
              value={formData.lineNumbers}
              onChange={(e) =>
                setFormData({
                  ...formData,
                  lineNumbers: e.target.value as any,
                })
              }
            >
              <option value="on">On (Standard)</option>
              <option value="relative">Relative (Vim Style)</option>
              <option value="interval">Interval (Every 10 lines)</option>
              <option value="off">Off (Hidden)</option>
            </select>
          </div>

          {/* Cursor Blinking */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <label
              style={{
                fontSize: '12px',
                fontWeight: 500,
                color: 'var(--text-muted)',
              }}
            >
              Cursor Animation Style
            </label>
            <select
              className="glass-input"
              style={{ padding: '6px 10px', fontSize: '13px' }}
              value={formData.cursorBlinking}
              onChange={(e) =>
                setFormData({
                  ...formData,
                  cursorBlinking: e.target.value as any,
                })
              }
            >
              <option value="smooth">Smooth (Default)</option>
              <option value="blink">Standard Blink</option>
              <option value="phase">Phase</option>
              <option value="expand">Expand</option>
              <option value="solid">Solid (No blink)</option>
            </select>
          </div>

          {/* Render Whitespace */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <label
              style={{
                fontSize: '12px',
                fontWeight: 500,
                color: 'var(--text-muted)',
              }}
            >
              Whitespace Visibility
            </label>
            <select
              className="glass-input"
              style={{ padding: '6px 10px', fontSize: '13px' }}
              value={formData.renderWhitespace}
              onChange={(e) =>
                setFormData({
                  ...formData,
                  renderWhitespace: e.target.value as any,
                })
              }
            >
              <option value="selection">Selection (Only on selected text)</option>
              <option value="boundary">Boundary (Leading & Trailing)</option>
              <option value="trailing">Trailing Only</option>
              <option value="all">All Whitespace</option>
              <option value="none">None (Hidden)</option>
            </select>
          </div>

          {/* Minimap Toggle */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '10px 12px',
              backgroundColor: 'rgba(255, 255, 255, 0.03)',
              borderRadius: '8px',
              border: '1px solid var(--border)',
            }}
          >
            <div>
              <div style={{ fontSize: '13px', fontWeight: 500 }}>
                Code Minimap
              </div>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                Render zoomed-out overview sidebar on the right
              </div>
            </div>
            <input
              type="checkbox"
              checked={formData.minimap}
              onChange={(e) =>
                setFormData({ ...formData, minimap: e.target.checked })
              }
              style={{ width: '18px', height: '18px', cursor: 'pointer' }}
            />
          </div>

          {/* Footer Actions */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginTop: '10px',
              paddingTop: '16px',
              borderTop: '1px solid var(--border)',
            }}
          >
            <button
              type="button"
              className="glass-btn glass-btn-ghost"
              onClick={handleResetDefaults}
              style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
            >
              <IconRefresh size={12} />
              Reset Defaults
            </button>

            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                type="button"
                className="glass-btn glass-btn-ghost"
                onClick={onClose}
                disabled={saving}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="glass-btn glass-btn-primary"
                disabled={saving}
              >
                {saving ? 'Saving...' : 'Save Preferences'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
