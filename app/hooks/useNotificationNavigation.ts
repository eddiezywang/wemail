import { useEffect } from "react";
import { useNavigate } from "react-router";
import type { NotificationTarget } from "../../shared/wemail/notifications";
import { useUIStore } from "./useUIStore";

export function useNotificationNavigation(): void {
	const navigate = useNavigate();

	useEffect(() => {
		const subscribe = window.wemailDesktop?.onNotificationNavigate;
		if (!subscribe) return;
		return subscribe((target: NotificationTarget) => {
			switch (target.kind) {
				case "mail":
					navigate(`/message/${encodeURIComponent(target.messageId)}`);
					break;
				case "pendingAction": {
					window.sessionStorage.setItem(
						"wemail.pending-action-target",
						target.actionId,
					);
					const state = useUIStore.getState();
					if (!state.isAgentPanelOpen) state.toggleAgentPanel();
					navigate("/");
					break;
				}
				case "agentRun": {
					const state = useUIStore.getState();
					state.resumeAgentConversation(target.conversationId);
					if (!state.isAgentPanelOpen) state.toggleAgentPanel();
					if (target.runId) window.sessionStorage.setItem("wemail.agent-run-target", target.runId);
					navigate("/");
					break;
				}
				case "accountSettings":
					useUIStore.getState().openSettings("account");
					break;
				case "applicationMessage":
					navigate(
						`/notifications?message=${encodeURIComponent(target.messageId)}`,
					);
					break;
			}
		});
	}, [navigate]);
}
