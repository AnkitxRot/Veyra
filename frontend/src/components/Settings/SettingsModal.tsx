import React, { useState, useEffect } from 'react';
import { UserPreferences, UserProfile, ProfileDraft } from '../../types';
import { getProfile, updateProfile } from '../../api';
import { IconClose, IconSettings, IconRefresh } from '../common/Icons';

export const DEFAULT_PREFERENCES: UserPreferences = {
  fontSize: 13.5,
  tabSize: 4,
  wordWrap: 'off',
  minimap: false,
  lineNumbers: 'on',
  cursorBlinking: 'smooth',
  renderWhitespace: 'selection',
  formatOnSave: false,
};

const DISPLAY_NAME_MAX = 48;
const PRONOUNS_MAX = 24;
const BIO_MAX = 280;

const EMPTY_DRAFT: ProfileDraft = { displayName: '', pronouns: '', bio: '' };

/** `UserProfile` (nullable) → `ProfileDraft` (always strings). */
function profileToDraft(p: UserProfile): ProfileDraft {
  return {
    displayName: p.displayName ?? '',
    pronouns: p.pronouns ?? '',
    bio: p.bio ?? '',
  };
}

/** `ProfileDraft` → the PUT body: trimmed, blank → `null` (clears the field). */
function draftToPatch(d: ProfileDraft): {
  displayName: string | null;
  pronouns: string | null;
  bio: string | null;
} {
  const norm = (s: string) => {
    const t = s.trim();
    return t.length > 0 ? t : null;
  };
  return {
    displayName: norm(d.displayName),
    pronouns: norm(d.pronouns),
    bio: norm(d.bio),
  };
}

interface SettingsModalProps {
  isOpen: boolean;
  preferences: UserPreferences;
  onSave: (updated: Partial<UserPreferences>) => Promise<void>;
  onClose: () => void;
  /** The current user's immutable technical username — shown in the Profile
   *  helper text so a blank display name is unambiguous. */
  username: string;
  /** Demo session: the Profile tab renders read-only. The backend stays
   *  authoritative (it 403s a demo PUT); this is UX only. */
  isDemo?: boolean;
}

type SettingsTab = 'editor' | 'profile';

export default function SettingsModal({
  isOpen,
  preferences,
  onSave,
  onClose,
  username,
  isDemo = false,
}: SettingsModalProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>('editor');

  // --- Editor preferences (unchanged behavior) --------------------------
  const [formData, setFormData] = useState<UserPreferences>(preferences);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // --- Profile tab (self-contained, local state only) ------------------
  const [profileLoaded, setProfileLoaded] = useState(false);
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileDraft, setProfileDraft] = useState<ProfileDraft>(EMPTY_DRAFT);
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [profileSaved, setProfileSaved] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setFormData(preferences);
      setError(null);
      // Each open starts on Editor with a fresh Profile load — persisted
      // values are authoritative, so a stale draft never lingers between
      // sessions.
      setActiveTab('editor');
      setProfileLoaded(false);
      setProfileError(null);
      setProfileSaved(false);
      setProfileSaving(false);
    }
  }, [isOpen, preferences]);

  // Load the profile once, the first time the Profile tab is shown while the
  // modal is open. Never re-fetches on tab toggles or keystrokes. `cancelled`
  // is flipped only by this effect's own cleanup — which runs on unmount or
  // when `isOpen` / `activeTab` / `profileLoaded` actually change, never on an
  // unrelated re-render — so an in-flight load is not aborted mid-flight.
  useEffect(() => {
    if (!isOpen || activeTab !== 'profile' || profileLoaded) return;
    let cancelled = false;
    setProfileLoading(true);
    setProfileError(null);
    getProfile()
      .then((res) => {
        if (cancelled) return;
        setProfileDraft(profileToDraft(res.profile));
        setProfileLoaded(true);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setProfileError(
          err instanceof Error ? err.message : 'Failed to load profile',
        );
      })
      .finally(() => {
        if (!cancelled) setProfileLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, activeTab, profileLoaded]);

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

  const handleProfileSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (profileSaving || isDemo) return; // guard double-activation / demo
    setProfileSaving(true);
    setProfileError(null);
    setProfileSaved(false);
    try {
      const res = await updateProfile(draftToPatch(profileDraft));
      // Adopt the canonical server response as local state.
      setProfileDraft(profileToDraft(res.profile));
      setProfileSaved(true);
    } catch (err: any) {
      // Surface the server's own message (e.g. "displayName must be at most
      // 48 characters") — never a generic replacement.
      setProfileError(err?.message || 'Failed to save profile');
    } finally {
      setProfileSaving(false);
    }
  };

  const setDraftField = (field: keyof ProfileDraft, value: string) => {
    setProfileDraft((d) => ({ ...d, [field]: value }));
    setProfileSaved(false);
  };

  const counterStyle: React.CSSProperties = {
    fontSize: '11px',
    color: 'var(--text-muted)',
    alignSelf: 'flex-end',
  };
  const labelStyle: React.CSSProperties = {
    fontSize: '12px',
    fontWeight: 500,
    color: 'var(--text-muted)',
  };
  const helperStyle: React.CSSProperties = {
    fontSize: '11px',
    color: 'var(--text-muted)',
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
              Settings
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

        {/* Tab bar */}
        <div style={{ padding: '12px 20px 0' }}>
          <div className="glass-tabs-container" role="tablist" aria-label="Settings sections">
            <button
              type="button"
              role="tab"
              id="settings-tab-editor"
              aria-selected={activeTab === 'editor'}
              aria-controls="settings-panel-editor"
              className={`glass-tab ${activeTab === 'editor' ? 'active' : ''}`}
              onClick={() => setActiveTab('editor')}
            >
              Editor
            </button>
            <button
              type="button"
              role="tab"
              id="settings-tab-profile"
              aria-selected={activeTab === 'profile'}
              aria-controls="settings-panel-profile"
              className={`glass-tab ${activeTab === 'profile' ? 'active' : ''}`}
              onClick={() => setActiveTab('profile')}
            >
              Profile
            </button>
          </div>
        </div>

        {/* Editor tab — behavior unchanged from M22 */}
        {activeTab === 'editor' && (
          <form
            id="settings-panel-editor"
            role="tabpanel"
            aria-labelledby="settings-tab-editor"
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
              <label style={labelStyle}>
                Font Size:{' '}
                <strong style={{ color: 'var(--text)' }}>
                  {formData.fontSize}px
                </strong>
              </label>
              <div
                style={{ display: 'flex', alignItems: 'center', gap: '12px' }}
              >
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
              <label style={labelStyle}>Tab Size (Spaces)</label>
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
              <label style={labelStyle}>Word Wrap</label>
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
              <label style={labelStyle}>Line Numbers</label>
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
              <label style={labelStyle}>Cursor Animation Style</label>
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
              <label style={labelStyle}>Whitespace Visibility</label>
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
                <option value="selection">
                  Selection (Only on selected text)
                </option>
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

            {/* Format on Save Toggle (M66) */}
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
                  Format on Save
                </div>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                  Run the editor formatter every time a file is saved
                </div>
              </div>
              <input
                type="checkbox"
                checked={formData.formatOnSave}
                onChange={(e) =>
                  setFormData({ ...formData, formatOnSave: e.target.checked })
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
        )}

        {/* Profile tab — self-contained profile identity editor (M62-4) */}
        {activeTab === 'profile' && (
          <form
            id="settings-panel-profile"
            role="tabpanel"
            aria-labelledby="settings-tab-profile"
            onSubmit={handleProfileSave}
            style={{
              padding: '20px',
              display: 'flex',
              flexDirection: 'column',
              gap: '16px',
              overflowY: 'auto',
            }}
          >
            {profileLoading && !profileLoaded ? (
              <div style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
                Loading…
              </div>
            ) : (
              <>
                {isDemo && (
                  <div
                    role="note"
                    style={{
                      padding: '10px 14px',
                      borderRadius: '6px',
                      backgroundColor: 'rgba(137, 180, 250, 0.12)',
                      border: '1px solid rgba(137, 180, 250, 0.25)',
                      color: 'var(--text-muted)',
                      fontSize: '12px',
                    }}
                  >
                    Profile editing is disabled for demo sessions
                  </div>
                )}
                {profileError && (
                  <div
                    role="alert"
                    style={{
                      padding: '10px 14px',
                      borderRadius: '6px',
                      backgroundColor: 'rgba(243, 139, 168, 0.15)',
                      border: '1px solid rgba(243, 139, 168, 0.3)',
                      color: '#f38ba8',
                      fontSize: '13px',
                    }}
                  >
                    {profileError}
                  </div>
                )}
                {profileSaved && !profileError && (
                  <div
                    role="status"
                    style={{
                      padding: '10px 14px',
                      borderRadius: '6px',
                      backgroundColor: 'rgba(166, 227, 161, 0.15)',
                      border: '1px solid rgba(166, 227, 161, 0.3)',
                      color: '#a6e3a1',
                      fontSize: '13px',
                    }}
                  >
                    Profile saved
                  </div>
                )}

                {/* Display name */}
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '6px',
                  }}
                >
                  <label htmlFor="profile-display-name" style={labelStyle}>
                    Display name
                  </label>
                  <input
                    id="profile-display-name"
                    type="text"
                    className="glass-input"
                    style={{ padding: '6px 10px', fontSize: '13px' }}
                    maxLength={DISPLAY_NAME_MAX}
                    value={profileDraft.displayName}
                    disabled={isDemo || profileSaving}
                    aria-describedby="profile-display-name-help profile-display-name-count"
                    onChange={(e) =>
                      setDraftField('displayName', e.target.value)
                    }
                  />
                  <span
                    id="profile-display-name-count"
                    style={counterStyle}
                    aria-live="polite"
                  >
                    {profileDraft.displayName.length}/{DISPLAY_NAME_MAX}
                  </span>
                  <span id="profile-display-name-help" style={helperStyle}>
                    Shown to collaborators. Blank → @{username}.
                  </span>
                </div>

                {/* Pronouns */}
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '6px',
                  }}
                >
                  <label htmlFor="profile-pronouns" style={labelStyle}>
                    Pronouns
                  </label>
                  <input
                    id="profile-pronouns"
                    type="text"
                    className="glass-input"
                    style={{ padding: '6px 10px', fontSize: '13px' }}
                    maxLength={PRONOUNS_MAX}
                    value={profileDraft.pronouns}
                    disabled={isDemo || profileSaving}
                    aria-describedby="profile-pronouns-count"
                    onChange={(e) => setDraftField('pronouns', e.target.value)}
                  />
                  <span
                    id="profile-pronouns-count"
                    style={counterStyle}
                    aria-live="polite"
                  >
                    {profileDraft.pronouns.length}/{PRONOUNS_MAX}
                  </span>
                </div>

                {/* Bio */}
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '6px',
                  }}
                >
                  <label htmlFor="profile-bio" style={labelStyle}>
                    Bio
                  </label>
                  <textarea
                    id="profile-bio"
                    className="glass-input"
                    style={{
                      padding: '8px 10px',
                      fontSize: '13px',
                      minHeight: '80px',
                      resize: 'vertical',
                    }}
                    rows={4}
                    maxLength={BIO_MAX}
                    value={profileDraft.bio}
                    disabled={isDemo || profileSaving}
                    aria-describedby="profile-bio-count"
                    onChange={(e) => setDraftField('bio', e.target.value)}
                  />
                  <span
                    id="profile-bio-count"
                    style={counterStyle}
                    aria-live="polite"
                  >
                    {profileDraft.bio.length}/{BIO_MAX}
                  </span>
                </div>

                {/* Footer */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'flex-end',
                    gap: '8px',
                    marginTop: '10px',
                    paddingTop: '16px',
                    borderTop: '1px solid var(--border)',
                  }}
                >
                  <button
                    type="button"
                    className="glass-btn glass-btn-ghost"
                    onClick={onClose}
                    disabled={profileSaving}
                  >
                    Close
                  </button>
                  <button
                    type="submit"
                    className="glass-btn glass-btn-primary"
                    disabled={isDemo || profileSaving || !profileLoaded}
                  >
                    {profileSaving ? 'Saving…' : 'Save Profile'}
                  </button>
                </div>
              </>
            )}
          </form>
        )}
      </div>
    </div>
  );
}
