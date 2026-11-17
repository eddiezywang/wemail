import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryRouter, useLocation } from "react-router";
import type { NotificationTarget } from "../../shared/wemail/notifications";
import { useUIStore } from "./useUIStore";
import { useNotificationNavigation } from "./useNotificationNavigation";

function Probe() {
  useNotificationNavigation();
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}

describe("useNotificationNavigation", () => {
  let emit: ((target: NotificationTarget) => void) | undefined;
  const originalDesktop = window.wemailDesktop;

  beforeEach(() => {
    window.sessionStorage.clear();
    useUIStore.setState({
      isAgentPanelOpen: false,
      isSettingsOpen: false,
      settingsSection: "account",
    });
    window.wemailDesktop = {
      onNotificationNavigate: (callback) => {
        emit = callback;
        return () => {
          emit = undefined;
        };
      },
    };
  });

  afterEach(() => {
    window.wemailDesktop = originalDesktop;
    emit = undefined;
  });

  it("opens a mail deep link", () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <Probe />
      </MemoryRouter>,
    );

    act(() => {
      emit?.({ kind: "mail", accountId: "acct-1", messageId: "mail-1" });
    });

    expect(screen.getByTestId("location")).toHaveTextContent(
      "/message/mail-1",
    );
  });

  it("opens the Agent panel and targets the pending confirmation", () => {
    render(
      <MemoryRouter initialEntries={["/notifications"]}>
        <Probe />
      </MemoryRouter>,
    );

    act(() => {
      emit?.({
        kind: "pendingAction",
        accountId: "acct-1",
        actionId: "confirm-1",
      });
    });

    expect(screen.getByTestId("location")).toHaveTextContent("/");
    expect(useUIStore.getState().isAgentPanelOpen).toBe(true);
    expect(window.sessionStorage.getItem("wemail.pending-action-target")).toBe(
      "confirm-1",
    );
  });

  it("restores the exact Agent conversation and run", () => {
    render(
      <MemoryRouter initialEntries={["/notifications"]}>
        <Probe />
      </MemoryRouter>,
    );

    act(() => {
      emit?.({
        kind: "agentRun",
        accountId: "acct-1",
        conversationId: "conversation-7",
        runId: "run-9",
      });
    });

    expect(screen.getByTestId("location")).toHaveTextContent("/");
    expect(useUIStore.getState()).toMatchObject({
      isAgentPanelOpen: true,
      agentSessionId: "conversation-7",
    });
    expect(window.sessionStorage.getItem("wemail.agent-run-target")).toBe("run-9");
  });

  it("routes account recovery and application messages to their safe surfaces", () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <Probe />
      </MemoryRouter>,
    );

    act(() => {
      emit?.({ kind: "accountSettings", accountId: "acct-1" });
    });
    expect(useUIStore.getState()).toMatchObject({
      isSettingsOpen: true,
      settingsSection: "account",
    });

    act(() => {
      emit?.({
        kind: "applicationMessage",
        accountId: "acct-1",
        messageId: "notice-1",
      });
    });
    expect(screen.getByTestId("location")).toHaveTextContent(
      "/notifications?message=notice-1",
    );
  });
});
