// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Body-less component that registers WeMail's baseline command set on
 * mount. Pairs with `<CommandPalette />` (UI) and `useGlobalShortcuts`
 * (keyboard layer).
 *
 * Most commands fan out to either Zustand actions (`useUIStore`) or
 * React Query mutations (`useUpdateEmail`, `useMoveEmail`,
 * `useDeleteEmail`). Email-context commands no-op when no email is
 * selected or no mailbox is available — that's expected: the user
 * just typed `r` in the inbox shell.
 *
 * Navigation commands (j / k) dispatch a synthetic
 * `wemail:nav-next` / `wemail:nav-prev` event on `window`. The active
 * list view subscribes and decides what "next" means. When no
 * listener is attached the events fall on the floor — graceful
 * no-op.
 */

import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { Folders } from "shared/folders";
import { toast } from "sonner";
import { useGlobalShortcuts } from "~/hooks/useGlobalShortcuts";
import { useUIStore } from "~/hooks/useUIStore";
import { registerCommand, type Command } from "~/lib/commandPalette";
import { getUserFacingError } from "~/lib/user-facing-error";
import { folderRole } from "~/lib/folderRole";
import { useCurrentAccount } from "~/queries/currentAccount";
import { useFolders } from "~/queries/folders";
import {
	useDeleteEmail,
	useEmail,
	useMoveEmail,
	useUpdateEmail,
} from "~/queries/emails";
import type { Email } from "~/types";
import { ConfirmActionDialog } from "~/components/ui/confirm-action-dialog";

function navigateRequest(direction: "next" | "previous"): void {
	if (typeof window === "undefined") return;
	const eventName =
		direction === "next" ? "wemail:nav-next" : "wemail:nav-prev";
	window.dispatchEvent(new CustomEvent(eventName));
}

export default function CommandPaletteRegistrar() {
	useGlobalShortcuts();

	const navigate = useNavigate();
	const { data: currentAccount } = useCurrentAccount();
	const mailboxId = currentAccount?.account?.id ?? null;
	const { data: folders = [] } = useFolders(mailboxId ?? undefined);
	const canArchive = folders.some((folder) => folderRole(folder.id) === "archive");
	const selectedEmailId = useUIStore((state) => state.selectedEmailId);
	const isComposing = useUIStore((state) => state.isComposing);
	const { data: selectedEmail } = useEmail(
		mailboxId ?? undefined,
		selectedEmailId ?? undefined,
	) as { data?: Email };

	const updateEmail = useUpdateEmail();
	const moveEmail = useMoveEmail();
	const deleteEmail = useDeleteEmail();
	const [pendingAction, setPendingAction] = useState<{
		kind: "delete" | "spam";
		mailboxId: string;
		email: Email;
	} | null>(null);

	const confirmPendingAction = () => {
		if (!pendingAction) return;
		const { kind, mailboxId: targetMailboxId, email } = pendingAction;
		const options = {
			onSuccess: () => {
				toast.success(kind === "delete" ? "已移到回收站" : "已标记为垃圾邮件");
				setPendingAction(null);
				useUIStore.getState().closePanel();
			},
			onError: (err: unknown) =>
				toast.error(getUserFacingError(err, kind === "delete" ? "删除失败，请稍后重试。" : "操作失败，请稍后重试。")),
		};
		if (kind === "delete") {
			deleteEmail.mutate({ mailboxId: targetMailboxId, id: email.id }, options);
		} else {
			moveEmail.mutate({ mailboxId: targetMailboxId, id: email.id, folder: Folders.SPAM }, options);
		}
	};

	useEffect(() => {
		// Capture the latest store getter so handlers always read fresh
		// state instead of the closed-over snapshot at registration time.
		const getState = useUIStore.getState;

		const hasSelection = () => Boolean(selectedEmailId && mailboxId);
		// Archive needs a physical archive folder on the provider; drop the
		// action for mailboxes that have none (mirrors the list view).
		const composeOpen = () => getState().isComposing;

		const requireSelection = (
			fn: (args: { mailboxId: string; email: Email }) => void,
		) => {
			return () => {
				const id = getState().selectedEmailId;
				if (!id || !mailboxId || !selectedEmail) {
					toast.message("请先选择一封邮件");
					return;
				}
				fn({ mailboxId, email: selectedEmail });
			};
		};

		const commands: Command[] = [
			// ---------- Navigation ----------
			{
				id: "nav.nextEmail",
				title: "下一封邮件",
				section: "Navigation",
				shortcut: "j",
				handler: () => navigateRequest("next"),
			},
			{
				id: "nav.previousEmail",
				title: "上一封邮件",
				section: "Navigation",
				shortcut: "k",
				handler: () => navigateRequest("previous"),
			},

			// ---------- Actions ----------
			{
				id: "action.reply",
				title: "回复",
				section: "Actions",
				shortcut: "r",
				when: hasSelection,
				handler: requireSelection(({ email }) => {
					getState().startCompose({ mode: "reply", originalEmail: email });
				}),
			},
			{
				id: "action.replyAll",
				title: "回复全部",
				section: "Actions",
				shortcut: "shift+r",
				when: hasSelection,
				handler: requireSelection(({ email }) => {
					getState().startCompose({
						mode: "reply-all",
						originalEmail: email,
					});
				}),
			},
			{
				id: "action.forward",
				title: "转发",
				section: "Actions",
				shortcut: "f",
				when: hasSelection,
				handler: requireSelection(({ email }) => {
					getState().startCompose({ mode: "forward", originalEmail: email });
				}),
			},
			{
				id: "action.archive",
				title: "归档",
				section: "Actions",
				shortcut: "e",
				when: () => hasSelection() && canArchive,
				handler: requireSelection(({ mailboxId: mid, email }) => {
					moveEmail.mutate(
						{ mailboxId: mid, id: email.id, folder: Folders.ARCHIVE },
						{
							onSuccess: () => {
								toast.success("已归档");
								getState().closePanel();
							},
							onError: (err) =>
								toast.error(getUserFacingError(err, "归档失败，请稍后重试。")),
						},
					);
				}),
			},
			{
				id: "action.toggleRead",
				title: "标记已读 / 未读",
				section: "Actions",
				shortcut: "u",
				when: hasSelection,
				handler: requireSelection(({ mailboxId: mid, email }) => {
					updateEmail.mutate({
						mailboxId: mid,
						id: email.id,
						data: { read: !email.read },
					});
				}),
			},
			{
				id: "action.delete",
				title: "删除",
				section: "Actions",
				shortcut: "backspace",
				when: hasSelection,
				handler: requireSelection(({ mailboxId: mid, email }) => {
					setPendingAction({ kind: "delete", mailboxId: mid, email });
				}),
			},
			{
				id: "action.markSpam",
				title: "标记为垃圾邮件",
				section: "Actions",
				shortcut: "shift+1",
				when: hasSelection,
				handler: requireSelection(({ mailboxId: mid, email }) => {
					setPendingAction({ kind: "spam", mailboxId: mid, email });
				}),
			},
			{
				id: "action.createTodo",
				title: "新建待办（基于当前邮件）",
				section: "Actions",
				shortcut: "mod+shift+t",
				when: hasSelection,
				handler: () => {
					// EmailPanel listens for this event and opens its CreateTodoDialog
					// pre-populated with the currently selected email.
					if (typeof window !== "undefined") {
						window.dispatchEvent(new CustomEvent("wemail:create-todo"));
					}
				},
			},

			// ---------- Compose ----------
			{
				id: "compose.new",
				title: "撰写新邮件",
				section: "Compose",
				shortcut: "c",
				handler: () => getState().startCompose(),
			},
			{
				id: "compose.send",
				title: "发送邮件",
				section: "Compose",
				shortcut: "mod+enter",
				when: composeOpen,
				handler: () => {
					// ComposePanel listens for this event and triggers form submit so
					// validation and the existing send path run.
					if (typeof window !== "undefined") {
						window.dispatchEvent(new CustomEvent("wemail:compose-send"));
					}
				},
			},

			// ---------- App ----------
			{
				id: "app.openSettings",
				title: "打开设置",
				section: "App",
				shortcut: "mod+,",
				handler: () => getState().openSettings(),
			},
			{
				id: "app.toggleAgentPanel",
				title: "切换 AI 面板",
				section: "App",
				shortcut: "mod+`",
				handler: () => getState().toggleAgentPanel(),
			},
			{
				id: "app.openCommandPalette",
				title: "打开命令面板",
				section: "App",
				shortcut: "mod+k",
				handler: () => getState().toggleCommandPalette(),
			},

			// ---------- Folders ----------
			{
				id: "folder.inbox",
				title: "收件箱",
				section: "Folders",
				shortcut: "1",
				handler: () => navigate("/"),
			},
			{
				id: "folder.sent",
				title: "已发送",
				section: "Folders",
				shortcut: "2",
				handler: () => navigate(`/folder/${Folders.SENT}`),
			},
			{
				id: "folder.drafts",
				title: "草稿箱",
				section: "Folders",
				shortcut: "3",
				handler: () => navigate(`/folder/${Folders.DRAFT}`),
			},
			{
				id: "folder.trash",
				title: "垃圾箱",
				section: "Folders",
				shortcut: "4",
				handler: () => navigate(`/folder/${Folders.TRASH}`),
			},
		];

		const unsubs = commands.map((cmd) => registerCommand(cmd));
		return () => {
			for (const unsub of unsubs) unsub();
		};
		// We intentionally re-register when the wireable inputs change so
		// `when` predicates and handlers always close over fresh values.
	}, [
		navigate,
		mailboxId,
		selectedEmailId,
		selectedEmail,
		isComposing,
		updateEmail,
		moveEmail,
		deleteEmail,
		canArchive,
	]);

	return (
		<ConfirmActionDialog
			open={pendingAction !== null}
			onOpenChange={(open) => !open && setPendingAction(null)}
			title={pendingAction?.kind === "spam" ? "标记为垃圾邮件？" : "移到回收站？"}
			description={`目标：${pendingAction?.email.subject || "这封邮件"}`}
			confirmLabel={pendingAction?.kind === "spam" ? "标记为垃圾邮件" : "移到回收站"}
			pending={deleteEmail.isPending || moveEmail.isPending}
			onConfirm={confirmPendingAction}
		/>
	);
}
