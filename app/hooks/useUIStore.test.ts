// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { describe, expect, it } from "vitest";
import { useUIStore } from "~/hooks/useUIStore";

describe("useUIStore", () => {
  // Reset store between tests
  beforeEach(() => {
    useUIStore.setState({
      selectedEmailId: null,
      isComposing: false,
      _previousEmailId: null,
      composeOptions: { mode: "new", originalEmail: null },
      isComposeModalOpen: false,
      isSidebarOpen: false,
      isAgentPanelOpen: true,
      agentSessionMode: "home-fresh",
      agentSessionId: "conv-test-home",
      agentClearTick: 0,
    });
  });

  it("starts with no selected email", () => {
    expect(useUIStore.getState().selectedEmailId).toBeNull();
  });

  it("migrates legacy preference destinations into Advanced settings", () => {
    useUIStore.getState().openSettings("notifications");

    expect(useUIStore.getState()).toMatchObject({
      isSettingsOpen: true,
      settingsSection: "advanced",
    });

    useUIStore.getState().closeSettings();
    useUIStore.setState({ settingsSection: "account" });
  });

  it("selects an email and clears composing state", () => {
    useUIStore.getState().startCompose({ mode: "new" });
    expect(useUIStore.getState().isComposing).toBe(true);

    useUIStore.getState().selectEmail("msg-1");
    expect(useUIStore.getState().selectedEmailId).toBe("msg-1");
    expect(useUIStore.getState().isComposing).toBe(false);
  });

  it("clears only the stale email selection when changing product context", () => {
    useUIStore.getState().selectEmail("msg-1");
    useUIStore.getState().startCompose({ mode: "reply" });

    useUIStore.getState().clearSelectedEmail();

    const state = useUIStore.getState();
    expect(state.selectedEmailId).toBeNull();
    expect(state._previousEmailId).toBeNull();
    expect(state.isComposing).toBe(true);
  });

  it("starts composing in new mode", () => {
    useUIStore.getState().startCompose({ mode: "new" });
    const state = useUIStore.getState();
    expect(state.isComposing).toBe(true);
    expect(state.composeOptions.mode).toBe("new");
    expect(state.selectedEmailId).toBeNull();
  });

  it("starts composing in reply mode and keeps selected email", () => {
    useUIStore.getState().selectEmail("msg-1");
    useUIStore.getState().startCompose({ mode: "reply" });
    const state = useUIStore.getState();
    expect(state.isComposing).toBe(true);
    expect(state.composeOptions.mode).toBe("reply");
    expect(state.selectedEmailId).toBe("msg-1");
  });

  it("closes compose and restores previous email", () => {
    useUIStore.getState().selectEmail("msg-1");
    useUIStore.getState().startCompose({ mode: "reply" });
    useUIStore.getState().closeCompose();
    const state = useUIStore.getState();
    expect(state.isComposing).toBe(false);
    expect(state.selectedEmailId).toBe("msg-1");
    expect(state.composeOptions.mode).toBe("new");
  });

  it("closes panel and clears all state", () => {
    useUIStore.getState().selectEmail("msg-1");
    useUIStore.getState().startCompose({ mode: "reply" });
    useUIStore.getState().closePanel();
    const state = useUIStore.getState();
    expect(state.selectedEmailId).toBeNull();
    expect(state.isComposing).toBe(false);
    expect(state._previousEmailId).toBeNull();
  });

  it("toggles sidebar", () => {
    expect(useUIStore.getState().isSidebarOpen).toBe(false);
    useUIStore.getState().toggleSidebar();
    expect(useUIStore.getState().isSidebarOpen).toBe(true);
    useUIStore.getState().toggleSidebar();
    expect(useUIStore.getState().isSidebarOpen).toBe(false);
  });

  it("opens and closes sidebar explicitly", () => {
    useUIStore.getState().openSidebar();
    expect(useUIStore.getState().isSidebarOpen).toBe(true);
    useUIStore.getState().closeSidebar();
    expect(useUIStore.getState().isSidebarOpen).toBe(false);
  });

  it("toggles agent panel", () => {
    expect(useUIStore.getState().isAgentPanelOpen).toBe(true);
    useUIStore.getState().toggleAgentPanel();
    expect(useUIStore.getState().isAgentPanelOpen).toBe(false);
    useUIStore.getState().toggleAgentPanel();
    expect(useUIStore.getState().isAgentPanelOpen).toBe(true);
  });

  it("rotates agent session when clearing an email-scoped chat", () => {
    useUIStore.getState().selectEmail("msg-1");

    useUIStore.getState().clearAgentConversation();
    const firstSessionId = useUIStore.getState().agentSessionId;

    expect(firstSessionId).toBeTruthy();
    expect(firstSessionId).not.toBe("msg-1");

    useUIStore.getState().clearAgentConversation();
    expect(useUIStore.getState().agentSessionId).toBeTruthy();
    expect(useUIStore.getState().agentSessionId).not.toBe(firstSessionId);
  });

  it("opens selected mail in its trace conversation on demand", () => {
    useUIStore.getState().selectEmail("msg-1");

    // Selection alone no longer rotates the agent session — the panel opens
    // the mail-scoped conversation explicitly (AgentConversationAutoOpener).
    expect(useUIStore.getState().agentSessionMode).toBe("home-fresh");
    expect(useUIStore.getState().agentSessionId).toBe("conv-test-home");

    useUIStore.getState().openEmailAgentConversation("msg-1");

    expect(useUIStore.getState()).toMatchObject({
      selectedEmailId: "msg-1",
      agentSessionMode: "email-trace",
      agentSessionId: "msg-1",
    });
  });

  it("returns from mail trace to a different fresh home conversation", () => {
    useUIStore.getState().openEmailAgentConversation("msg-1");
    useUIStore.getState().startFreshAgentConversation();
    const firstHomeId = useUIStore.getState().agentSessionId;

    expect(useUIStore.getState().agentSessionMode).toBe("home-fresh");
    expect(firstHomeId).not.toBe("msg-1");
    expect(firstHomeId).not.toBe("conv-test-home");

    useUIStore.getState().openEmailAgentConversation("msg-2");
    expect(useUIStore.getState().agentSessionId).toBe("msg-2");
    useUIStore.getState().startFreshAgentConversation();
    expect(useUIStore.getState().agentSessionMode).toBe("home-fresh");
    expect(useUIStore.getState().agentSessionId).not.toBe(firstHomeId);
  });

  it("restores only an explicitly selected history conversation", () => {
    useUIStore.getState().resumeAgentConversation("conv-history-1");

    expect(useUIStore.getState()).toMatchObject({
      agentSessionMode: "history-resume",
      agentSessionId: "conv-history-1",
    });
  });

  it("mail trace takes over after manually restoring history", () => {
    useUIStore.getState().resumeAgentConversation("conv-history-1");
    useUIStore.getState().openEmailAgentConversation("msg-2");

    expect(useUIStore.getState()).toMatchObject({
      agentSessionMode: "email-trace",
      agentSessionId: "msg-2",
    });
  });

  it("opens and closes compose modal", () => {
    useUIStore.getState().openComposeModal({ mode: "forward" });
    expect(useUIStore.getState().isComposeModalOpen).toBe(true);
    expect(useUIStore.getState().composeOptions.mode).toBe("forward");
    useUIStore.getState().closeComposeModal();
    expect(useUIStore.getState().isComposeModalOpen).toBe(false);
  });

  it("startCompose closes sidebar", () => {
    useUIStore.getState().openSidebar();
    expect(useUIStore.getState().isSidebarOpen).toBe(true);
    useUIStore.getState().startCompose({ mode: "new" });
    expect(useUIStore.getState().isSidebarOpen).toBe(false);
  });
});
