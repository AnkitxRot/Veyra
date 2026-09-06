import { useEffect, useState, type CSSProperties } from "react";
import { getUserColor } from "../../collab/presence";
import { avatarUrl } from "../../api";

/**
 * M72 — the one avatar primitive. Renders the uploaded image when
 * `avatarVersion > 0`, otherwise two-letter initials on a deterministic
 * `getUserColor(userId)` background. A failed image load falls back to the
 * same initials. Initials come from the immutable username, so a display-name
 * change never churns the glyph.
 */

export interface UserAvatarProps {
  userId: number;
  username: string;
  /** Rendered pixel size (square). */
  size: number;
  /** 0 / omitted → initials fallback. */
  avatarVersion?: number;
  /** Override the initials background (defaults to `getUserColor(userId)`). */
  color?: string;
  /** Fetch the caller's own avatar via `/api/auth/profile/avatar`. */
  self?: boolean;
  className?: string;
  title?: string;
}

export default function UserAvatar({
  userId,
  username,
  size,
  avatarVersion = 0,
  color,
  self = false,
  className,
  title,
}: UserAvatarProps) {
  const [failed, setFailed] = useState(false);
  // A new version (or a different user) is a fresh image — retry.
  useEffect(() => {
    setFailed(false);
  }, [avatarVersion, userId]);

  const initials = username.slice(0, 2).toUpperCase();
  const showImage = avatarVersion > 0 && !failed;

  const box: CSSProperties = {
    width: size,
    height: size,
    borderRadius: "50%",
    flexShrink: 0,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    objectFit: "cover",
    userSelect: "none",
    fontWeight: 700,
    fontSize: Math.max(8, Math.round(size * 0.4)),
    lineHeight: 1,
  };

  if (showImage) {
    return (
      <img
        className={className}
        src={avatarUrl(userId, avatarVersion, self)}
        alt=""
        width={size}
        height={size}
        title={title}
        onError={() => setFailed(true)}
        style={box}
      />
    );
  }

  return (
    <span
      className={className}
      title={title}
      aria-hidden="true"
      style={{
        ...box,
        background: color ?? getUserColor(userId),
        color: "#11131c",
      }}
    >
      {initials}
    </span>
  );
}
