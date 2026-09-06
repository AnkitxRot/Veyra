import UserAvatar from "./UserAvatar";

/**
 * M72 — the one compact identity card. Avatar + display name + `@username`,
 * plus pronouns and bio only when the user has set them, plus an optional
 * presence chip the caller supplies from data it already has. Every field
 * renders as plain React text — no markup sink. This is presentation only:
 * `userId` / `username` stay the technical identity everywhere else.
 *
 * Deliberately NOT here: followers, likes, activity feeds, links, badges.
 */

export type ProfilePresenceTone =
  | "online"
  | "idle"
  | "away"
  | "dnd"
  | "offline";

export interface ProfileCardProps {
  userId: number;
  username: string;
  displayName?: string | null;
  avatarVersion?: number;
  pronouns?: string | null;
  bio?: string | null;
  /** A presence line, when the caller already has one to show. */
  presence?: { label: string; tone: ProfilePresenceTone } | null;
  /** Fetch the caller's own avatar via the self route. */
  self?: boolean;
  avatarSize?: number;
}

export default function ProfileCard({
  userId,
  username,
  displayName,
  avatarVersion = 0,
  pronouns,
  bio,
  presence,
  self = false,
  avatarSize = 40,
}: ProfileCardProps) {
  const label =
    typeof displayName === "string" && displayName.trim().length > 0
      ? displayName
      : username;
  const showHandle = label !== username;

  return (
    <div className="profile-card">
      <UserAvatar
        userId={userId}
        username={username}
        size={avatarSize}
        avatarVersion={avatarVersion}
        self={self}
      />
      <div className="profile-card__body">
        <div className="profile-card__name-row">
          <span className="profile-card__name">{label}</span>
          {showHandle && (
            <span className="profile-card__handle">@{username}</span>
          )}
        </div>
        {(pronouns || presence) && (
          <div className="profile-card__meta-row">
            {pronouns && (
              <span className="profile-card__pronouns">{pronouns}</span>
            )}
            {presence && (
              <span
                className={`profile-card__presence profile-card__presence--${presence.tone}`}
              >
                <span className="profile-card__presence-dot" />
                {presence.label}
              </span>
            )}
          </div>
        )}
        {bio && <div className="profile-card__bio">{bio}</div>}
      </div>
    </div>
  );
}
