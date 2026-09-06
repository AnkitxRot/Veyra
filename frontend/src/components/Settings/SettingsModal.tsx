import React, { useState, useEffect } from 'react';
import {
  UserPreferences,
  UserProfile,
  ProfileDraft,
  EDITOR_PREFERENCE_KEYS,
} from '../../types';
import {
  getProfile,
  updateProfile,
  uploadAvatar,
  removeAvatar,
} from '../../api';
import { IconClose, IconSettings, IconRefresh } from '../common/Icons';
import UserAvatar from '../common/UserAvatar';
import {
  CONFIGURABLE_COMMANDS,
  DEFAULT_KEYMAP,
  chordFromEvent,
  isValidChord,
  chordToDisplay,
  findConflict,
  getCommand,
  IS_MAC,
  type CommandId,
  type Keymap,
} from '../../keymap/keymap';

export const DEFAULT_PREFERENCES: UserPreferences = {
  fontSize: 13.5,
  tabSize: 4,
  wordWrap: 'off',
  minimap: false,
  lineNumbers: 'on',
  cursorBlinking: 'smooth',
  renderWhitespace: 'selection',
  formatOnSave: false,
  // M69: appearance preference — the modal renders + submits this one.
  theme: 'system',
  // M70: keybinding overrides — the Keybindings tab owns this; carried here
  // for type completeness. `pickEditorPrefs` never includes it.
  keymap: {},
  // M67 layout keys — carried for type completeness only; the modal never
  // renders or submits them (see `pickEditorPrefs`).
  sidebarWidth: 250,
  bottomHeight: 260,
  sidebarHidden: false,
  bottomCollapsed: false,
};

/** The editor-tab payload: only the keys this modal owns. Layout keys persist
 *  through direct IDE interaction, so "Reset Defaults" + Save here must never
 *  rewrite the user's panel layout. */
function pickEditorPrefs(p: UserPreferences): Partial<UserPreferences> {
  const out: Partial<UserPreferences> = {};
  for (const k of EDITOR_PREFERENCE_KEYS) {
    (out as Record<string, unknown>)[k] = p[k];
  }
  return out;
}

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
  /** The current user's id — only used to pick the initials-fallback colour
   *  for the avatar preview. Defaults to 0 when a caller has no id to give. */
  userId?: number;
  /** Demo session: the Profile tab renders read-only. The backend stays
   *  authoritative (it 403s a demo PUT); this is UX only. */
  isDemo?: boolean;
}

type SettingsTab = 'editor' | 'profile' | 'keybindings';

/** Human label for a chord in the current platform's convention. */
function label(chord: string): string {
  return chordToDisplay(chord, IS_MAC);
}

export default function SettingsModal({
  isOpen,
  preferences,
  onSave,
  onClose,
  username,
  userId = 0,
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
  // M72 — avatar. `avatarVersion` mirrors the server (0 = none); the local
  // object-URL preview only exists for the instant between picking a file
  // and the upload resolving.
  const [avatarVersion, setAvatarVersion] = useState(0);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);

  // --- Keybindings tab (M70) — draft = the override map ----------------
  const [keymapDraft, setKeymapDraft] = useState<Keymap>(preferences.keymap);
  const [capturingId, setCapturingId] = useState<CommandId | null>(null);
  const [capturedChord, setCapturedChord] = useState<string | null>(null);
  const [captureError, setCaptureError] = useState<string | null>(null);

  // Adopt the server-authoritative preferences — on open AND after an
  // in-modal save re-issues them (so the Keybindings draft and the Editor
  // form stay in sync without a stale override lingering).
  useEffect(() => {
    if (!isOpen) return;
    setFormData(preferences);
    setKeymapDraft(preferences.keymap);
  }, [isOpen, preferences]);

  // Per-open resets — NOT re-run when a save changes `preferences`, so an
  // Apply / Reset in the Keybindings tab never bounces the user to Editor.
  useEffect(() => {
    if (!isOpen) return;
    setCapturingId(null);
    setCapturedChord(null);
    setCaptureError(null);
    setError(null);
    setActiveTab('editor');
    setProfileLoaded(false);
    setProfileError(null);
    setProfileSaved(false);
    setProfileSaving(false);
    setAvatarError(null);
    setAvatarBusy(false);
  }, [isOpen]);

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
        setAvatarVersion(res.profile.avatarVersion ?? 0);
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
      await onSave(pickEditorPrefs(formData));
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

  // M72 — avatar. The server is authoritative for the real bytes check;
  // these client-side guards only spare an obviously-doomed round trip.
  const AVATAR_ACCEPT = 'image/png,image/jpeg,image/webp';
  const AVATAR_MAX_BYTES = 512 * 1024;

  const handleAvatarPick = async (
    e: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-picking the same file after an error
    if (!file || isDemo || avatarBusy) return;
    setAvatarError(null);
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) {
      setAvatarError('Choose a PNG, JPEG or WebP image.');
      return;
    }
    if (file.size > AVATAR_MAX_BYTES) {
      setAvatarError('Image must be 512 KB or smaller.');
      return;
    }
    setAvatarBusy(true);
    try {
      const res = await uploadAvatar(file);
      setAvatarVersion(res.avatarVersion);
    } catch (err: any) {
      setAvatarError(err?.message || 'Avatar upload failed.');
    } finally {
      setAvatarBusy(false);
    }
  };

  const handleAvatarRemove = async () => {
    if (isDemo || avatarBusy || avatarVersion === 0) return;
    setAvatarError(null);
    setAvatarBusy(true);
    try {
      await removeAvatar();
      setAvatarVersion(0);
    } catch (err: any) {
      setAvatarError(err?.message || 'Could not remove the avatar.');
    } finally {
      setAvatarBusy(false);
    }
  };

  // --- Keybindings handlers (M70) -------------------------------------
  const resolvedChord = (id: CommandId): string =>
    keymapDraft[id] ?? DEFAULT_KEYMAP[id];

  const startCapture = (id: CommandId) => {
    setCapturingId(id);
    setCapturedChord(null);
    setCaptureError(null);
  };
  const cancelCapture = () => {
    setCapturingId(null);
    setCapturedChord(null);
    setCaptureError(null);
  };

  const onCaptureKeyDown = (e: React.KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!capturingId) return;
    if (e.key === 'Escape') {
      cancelCapture();
      return;
    }
    const chord = chordFromEvent(e.nativeEvent);
    if (!chord) return; // bare modifier / unmappable — keep waiting
    if (!isValidChord(chord)) {
      setCapturedChord(chord);
      setCaptureError(
        'That combination is not usable — it needs Ctrl/⌘ and is not a browser-reserved shortcut.',
      );
      return;
    }
    const conflict = findConflict(keymapDraft, capturingId, chord);
    setCapturedChord(chord);
    setCaptureError(
      conflict
        ? `${label(chord)} is already bound to "${getCommand(conflict)?.title ?? conflict}".`
        : null,
    );
  };

  const applyCapture = () => {
    if (!capturingId || !capturedChord || captureError) return;
    const next: Keymap = { ...keymapDraft };
    if (capturedChord === DEFAULT_KEYMAP[capturingId]) delete next[capturingId];
    else next[capturingId] = capturedChord;
    setKeymapDraft(next);
    cancelCapture();
    void onSave({ keymap: next }).catch(() => {
      /* persistence failure is surfaced by the caller's own handling */
    });
  };

  const resetOne = (id: CommandId) => {
    if (!(id in keymapDraft)) return;
    const next: Keymap = { ...keymapDraft };
    delete next[id];
    setKeymapDraft(next);
    if (capturingId === id) cancelCapture();
    void onSave({ keymap: next }).catch(() => {});
  };

  const resetAll = () => {
    if (Object.keys(keymapDraft).length === 0) return;
    setKeymapDraft({});
    cancelCapture();
    void onSave({ keymap: {} }).catch(() => {});
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
            <button
              type="button"
              role="tab"
              id="settings-tab-keybindings"
              aria-selected={activeTab === 'keybindings'}
              aria-controls="settings-panel-keybindings"
              className={`glass-tab ${activeTab === 'keybindings' ? 'active' : ''}`}
              onClick={() => setActiveTab('keybindings')}
            >
              Keybindings
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

            {/* Theme / Appearance (M69) */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <label htmlFor="settings-theme" style={labelStyle}>
                Theme
              </label>
              <select
                id="settings-theme"
                className="glass-input"
                style={{ padding: '6px 10px', fontSize: '13px' }}
                value={formData.theme}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    theme: e.target.value as UserPreferences['theme'],
                  })
                }
              >
                <option value="system">System (match your device)</option>
                <option value="dark">Dark</option>
                <option value="light">Light</option>
              </select>
            </div>

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

                {/* Avatar */}
                <div className="profile-avatar-row">
                  <UserAvatar
                    userId={userId}
                    username={username}
                    size={64}
                    avatarVersion={avatarVersion}
                    self
                  />
                  <div className="profile-avatar-actions">
                    <div className="profile-avatar-buttons">
                      <label
                        className="glass-btn"
                        style={{
                          fontSize: '12px',
                          cursor:
                            isDemo || avatarBusy ? 'not-allowed' : 'pointer',
                          opacity: isDemo || avatarBusy ? 0.5 : 1,
                        }}
                      >
                        {avatarVersion > 0 ? 'Replace' : 'Upload'}
                        <input
                          type="file"
                          accept={AVATAR_ACCEPT}
                          hidden
                          disabled={isDemo || avatarBusy}
                          onChange={handleAvatarPick}
                        />
                      </label>
                      {avatarVersion > 0 && (
                        <button
                          type="button"
                          className="glass-btn"
                          style={{ fontSize: '12px' }}
                          disabled={isDemo || avatarBusy}
                          onClick={handleAvatarRemove}
                        >
                          Remove
                        </button>
                      )}
                    </div>
                    {avatarError ? (
                      <span
                        className="profile-avatar-error"
                        role="alert"
                      >
                        {avatarError}
                      </span>
                    ) : (
                      <span className="profile-avatar-hint">
                        {avatarBusy
                          ? 'Working…'
                          : 'PNG, JPEG or WebP, up to 512 KB.'}
                      </span>
                    )}
                  </div>
                </div>

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

        {/* Keybindings tab (M70) */}
        {activeTab === 'keybindings' && (
          <div
            id="settings-panel-keybindings"
            role="tabpanel"
            aria-labelledby="settings-tab-keybindings"
            style={{
              padding: '20px',
              display: 'flex',
              flexDirection: 'column',
              gap: '12px',
              overflowY: 'auto',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '8px',
              }}
            >
              <span style={helperStyle}>
                Shortcuts for IDE commands. {IS_MAC ? '⌘' : 'Ctrl'} is required;
                editor text-entry, copy/paste/undo and browser shortcuts are
                left alone.
              </span>
              <button
                type="button"
                className="glass-btn glass-btn-ghost"
                onClick={resetAll}
                disabled={Object.keys(keymapDraft).length === 0}
                style={{ flexShrink: 0, fontSize: '11px', padding: '4px 10px' }}
              >
                Reset all keybindings
              </button>
            </div>

            <ul
              role="list"
              style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '6px' }}
            >
              {CONFIGURABLE_COMMANDS.map((cmd) => {
                const id = cmd.id;
                const isOverridden = id in keymapDraft;
                const current = resolvedChord(id);
                const capturing = capturingId === id;
                const shown = capturing && capturedChord ? capturedChord : current;
                return (
                  <li
                    key={id}
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '6px',
                      padding: '10px 12px',
                      borderRadius: '8px',
                      border: '1px solid var(--border)',
                      background: 'rgba(255, 255, 255, 0.03)',
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: '10px',
                      }}
                    >
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: '13px', fontWeight: 500 }}>
                          {cmd.title}
                        </div>
                        <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                          {cmd.description}
                        </div>
                      </div>
                      <div
                        style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}
                      >
                        <kbd
                          style={{
                            fontFamily: 'var(--font-mono)',
                            fontSize: '12px',
                            padding: '3px 8px',
                            borderRadius: '4px',
                            border: '1px solid var(--border)',
                            background: 'var(--input-bg)',
                          }}
                        >
                          {label(shown)}
                        </kbd>
                        {!capturing && (
                          <button
                            type="button"
                            className="glass-btn glass-btn-ghost"
                            style={{ fontSize: '11px', padding: '4px 10px' }}
                            onClick={() => startCapture(id)}
                          >
                            Edit
                          </button>
                        )}
                        <button
                          type="button"
                          className="glass-btn glass-btn-ghost"
                          style={{ fontSize: '11px', padding: '4px 10px' }}
                          onClick={() => resetOne(id)}
                          disabled={!isOverridden}
                        >
                          Reset
                        </button>
                      </div>
                    </div>

                    {capturing && (
                      <div
                        style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}
                      >
                        <input
                          data-keybinding-capture=""
                          type="text"
                          readOnly
                          autoFocus
                          aria-label={`Press the new shortcut for ${cmd.title}`}
                          value={
                            capturedChord ? label(capturedChord) : 'Press keys…'
                          }
                          onKeyDown={onCaptureKeyDown}
                          className="glass-input"
                          style={{
                            padding: '6px 10px',
                            fontSize: '13px',
                            fontFamily: 'var(--font-mono)',
                          }}
                        />
                        {captureError && (
                          <span
                            role="alert"
                            style={{ fontSize: '11px', color: 'var(--error)' }}
                          >
                            {captureError}
                          </span>
                        )}
                        <div style={{ display: 'flex', gap: '6px' }}>
                          <button
                            type="button"
                            className="glass-btn glass-btn-primary"
                            style={{ fontSize: '11px', padding: '4px 12px' }}
                            onClick={applyCapture}
                            disabled={!capturedChord || !!captureError}
                          >
                            Apply
                          </button>
                          <button
                            type="button"
                            className="glass-btn glass-btn-ghost"
                            style={{ fontSize: '11px', padding: '4px 12px' }}
                            onClick={cancelCapture}
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
