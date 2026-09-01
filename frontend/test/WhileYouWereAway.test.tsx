import { describe, it, expect, vi, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  act,
} from "@testing-library/react";
import * as React from "react";
import WhileYouWereAway from "../src/components/Collab/WhileYouWereAway";
import type { TimelineEvent } from "../src/types";

afterEach(cleanup);

const evt: TimelineEvent = {
  id: "collab:1",
  kind: "edit_burst",
  at: new Date().toISOString(),
  actor: { userId: 7, username: "rahul" },
  filePath: "auth/session.ts",
  title: "changed auth/session.ts",
  navigable: true,
};

const groups = [
  {
    username: "rahul",
    userId: 7,
    lines: ["edited auth/session.ts"],
    events: [evt],
  },
];

describe("WhileYouWereAway", () => {
  it("renders a header and the grouped events", () => {
    render(
      <WhileYouWereAway
        groups={groups}
        onNavigate={() => {}}
        onDismiss={() => {}}
        autoDismissMs={99999}
      />,
    );
    expect(screen.getByText(/while you were away/i)).toBeTruthy();
    expect(screen.getByText("rahul")).toBeTruthy();
    expect(screen.getByText(/edited auth\/session\.ts/)).toBeTruthy();
  });

  it("Dismiss calls onDismiss", () => {
    const d = vi.fn();
    render(
      <WhileYouWereAway
        groups={groups}
        onNavigate={() => {}}
        onDismiss={d}
        autoDismissMs={99999}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(d).toHaveBeenCalledTimes(1);
  });

  it("a navigable line calls onNavigate with its event", () => {
    const nav = vi.fn();
    render(
      <WhileYouWereAway
        groups={groups}
        onNavigate={nav}
        onDismiss={() => {}}
        autoDismissMs={99999}
      />,
    );
    fireEvent.click(screen.getByText(/edited auth\/session\.ts/));
    expect(nav).toHaveBeenCalledWith(evt);
  });

  it("auto-dismisses after autoDismissMs (exactly once)", () => {
    vi.useFakeTimers();
    const d = vi.fn();
    render(
      <WhileYouWereAway
        groups={groups}
        onNavigate={() => {}}
        onDismiss={d}
        autoDismissMs={1000}
      />,
    );
    act(() => {
      vi.advanceTimersByTime(1100);
    });
    expect(d).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("a non-navigable line (no filePath) is not clickable", () => {
    const nav = vi.fn();
    render(
      <WhileYouWereAway
        groups={[
          {
            username: "priya",
            userId: 8,
            lines: ['committed "Fix header"'],
            events: [
              {
                ...evt,
                id: "commit:1",
                kind: "commit",
                filePath: undefined,
                navigable: false,
                title: 'committed "Fix header"',
              },
            ],
          },
        ]}
        onNavigate={nav}
        onDismiss={() => {}}
        autoDismissMs={99999}
      />,
    );
    fireEvent.click(screen.getByText(/committed "Fix header"/));
    expect(nav).not.toHaveBeenCalled();
  });
});
