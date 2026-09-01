import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import * as React from "react";
import ActivityTimeline from "../src/components/Collab/ActivityTimeline";
import type { TimelineEvent } from "../src/types";

afterEach(cleanup);

const ev = (o: Partial<TimelineEvent> = {}): TimelineEvent => ({
  id: "collab:1",
  kind: "edit_burst",
  at: new Date().toISOString(),
  actor: { userId: 7, username: "rahul" },
  filePath: "src/auth/session.ts",
  title: "changed lines 40–52",
  navigable: true,
  ...o,
});

describe("ActivityTimeline", () => {
  it("renders rows with actor + title", () => {
    render(
      <ActivityTimeline
        events={[
          ev(),
          ev({
            id: "collab:2",
            kind: "commit",
            actor: { userId: 8, username: "priya" },
            title: 'committed "Fix"',
            navigable: false,
            filePath: undefined,
          }),
        ]}
        hasMore={false}
        onLoadMore={() => {}}
        onNavigate={() => {}}
      />,
    );
    expect(screen.getByText("rahul")).toBeTruthy();
    expect(screen.getByText("priya")).toBeTruthy();
    expect(screen.getByText(/changed lines 40/)).toBeTruthy();
    expect(screen.getByText(/committed "Fix"/)).toBeTruthy();
  });

  it("clicking a navigable row calls onNavigate; a non-navigable row does not", () => {
    const nav = vi.fn();
    render(
      <ActivityTimeline
        events={[
          ev({ id: "n1" }),
          ev({
            id: "n2",
            navigable: false,
            filePath: undefined,
            kind: "commit",
            title: "committed",
          }),
        ]}
        hasMore={false}
        onLoadMore={() => {}}
        onNavigate={nav}
      />,
    );
    fireEvent.click(screen.getByText(/changed lines 40/));
    expect(nav).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText("committed"));
    expect(nav).toHaveBeenCalledTimes(1);
  });

  it("[Show more] calls onLoadMore only when hasMore", () => {
    const more = vi.fn();
    const { rerender } = render(
      <ActivityTimeline
        events={[ev()]}
        hasMore
        onLoadMore={more}
        onNavigate={() => {}}
      />,
    );
    fireEvent.click(screen.getByText(/show more/i));
    expect(more).toHaveBeenCalled();

    rerender(
      <ActivityTimeline
        events={[ev()]}
        hasMore={false}
        onLoadMore={more}
        onNavigate={() => {}}
      />,
    );
    expect(screen.queryByText(/show more/i)).toBeNull();
  });

  it("shows an empty state when there are no events", () => {
    render(
      <ActivityTimeline
        events={[]}
        hasMore={false}
        onLoadMore={() => {}}
        onNavigate={() => {}}
      />,
    );
    expect(screen.getByText(/no recent activity/i)).toBeTruthy();
  });
});
