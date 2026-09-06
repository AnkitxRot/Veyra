// M73 — the follow-session generation token.
//
// The follow lifecycle in IDE.tsx spans React state, window timers and an
// async "return to my location" open. Any continuation captured during one
// follow session (a resolved await, a fired absence timer, a "follow-left"
// notice action or its TTL onExpire) must become inert the moment a *new*
// follow session begins — otherwise a prior target's lifecycle can navigate
// the editor, clear the new target's anchor, or expire into the new session
// (the M59/M64 "stale follow-left" class of bug).
//
// This is deliberately a tiny counter, not a store: it holds no target, no
// anchor, no React state. IDE.tsx bumps it on every real transition (start /
// switch / stop / return / reset) and hands the returned token to each
// deferred continuation, which checks `isCurrent(token)` before acting.

export class FollowGeneration {
  private gen = 0;

  /** The token for the follow session live right now. */
  current(): number {
    return this.gen;
  }

  /** End the current session; returns the new (now-current) token. */
  bump(): number {
    this.gen += 1;
    return this.gen;
  }

  /** True only while `token` still names the live session. */
  isCurrent(token: number): boolean {
    return token === this.gen;
  }
}
