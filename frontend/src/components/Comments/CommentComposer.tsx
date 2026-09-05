import React, { useMemo, useRef, useState } from "react";

export interface ComposerMember {
  userId: number;
  /** Immutable technical username — the mention token (`@username`) and the
   *  identity key. Autocomplete matches and inserts THIS, never displayName. */
  username: string;
  /** M62: effective display name for the author row. `null` / absent →
   *  fall back to `username`. Presentation only — never a mention token. */
  displayName?: string | null;
}

export interface CommentComposerProps {
  members: ComposerMember[];
  value?: string;
  onChange?: (v: string) => void;
  onSubmit: (input: { body: string; mentions: number[] }) => void;
  placeholder?: string;
  autoFocus?: boolean;
  submitLabel?: string;
}

/**
 * M61-A textarea composer with `@` member autocomplete. Enter submits,
 * Shift+Enter inserts a newline. Mentions are derived on submit by matching
 * `@token`s against the known project members — an unknown `@handle` stays
 * literal text and is never a mention.
 */
export default function CommentComposer({
  members,
  value = "",
  onChange,
  onSubmit,
  placeholder,
  autoFocus,
  submitLabel = "Comment",
}: CommentComposerProps) {
  const [text, setText] = useState(value);
  const [menuIndex, setMenuIndex] = useState(0);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const activeToken = useMemo(() => {
    const m = /(^|\s)@(\w*)$/.exec(text);
    return m ? m[2] : null;
  }, [text]);

  const suggestions = useMemo(() => {
    if (activeToken == null) return [];
    const q = activeToken.toLowerCase();
    return members
      .filter((mem) => mem.username.toLowerCase().startsWith(q))
      .slice(0, 6);
  }, [activeToken, members]);

  const update = (v: string) => {
    setText(v);
    onChange?.(v);
    setMenuIndex(0);
  };

  const pick = (mem: ComposerMember) => {
    const next = text.replace(/@(\w*)$/, `@${mem.username} `);
    update(next);
    taRef.current?.focus();
  };

  const deriveMentions = (body: string): number[] => {
    const ids = new Set<number>();
    const re = /@(\w+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) {
      const found = members.find(
        (mem) => mem.username.toLowerCase() === m![1].toLowerCase(),
      );
      if (found) ids.add(found.userId);
    }
    return [...ids];
  };

  const submit = () => {
    const body = text.trim();
    if (!body) return;
    onSubmit({ body, mentions: deriveMentions(body) });
    update("");
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (suggestions.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMenuIndex((i) => (i + 1) % suggestions.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMenuIndex((i) => (i - 1 + suggestions.length) % suggestions.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pick(suggestions[menuIndex]);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="comment-composer">
      <textarea
        ref={taRef}
        className="glass-input comment-composer-input"
        value={text}
        placeholder={placeholder}
        aria-label={placeholder ?? "Comment"}
        autoFocus={autoFocus}
        rows={3}
        onChange={(e) => update(e.target.value)}
        onKeyDown={onKeyDown}
      />
      {suggestions.length > 0 && (
        <ul className="comment-mention-menu" role="listbox">
          {suggestions.map((mem, i) => (
            <li
              key={mem.userId}
              role="option"
              aria-selected={i === menuIndex}
              className={
                i === menuIndex
                  ? "comment-mention-item is-active"
                  : "comment-mention-item"
              }
              onMouseDown={(e) => {
                e.preventDefault();
                pick(mem);
              }}
            >
              @{mem.username}
            </li>
          ))}
        </ul>
      )}
      <div className="comment-composer-actions">
        <button
          type="button"
          className="glass-btn glass-btn-primary"
          onClick={submit}
          disabled={!text.trim()}
        >
          {submitLabel}
        </button>
      </div>
    </div>
  );
}
