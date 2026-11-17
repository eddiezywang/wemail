// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { DotsThreeIcon } from "@phosphor-icons/react/DotsThree";
import { PencilSimpleIcon } from "@phosphor-icons/react/PencilSimple";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "~/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "~/components/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { Input } from "~/components/ui/input";
import { getUserFacingError } from "~/lib/user-facing-error";
import api, { type AccountCurrentResponse } from "~/services/api";
import { AiUsageSection } from "./AiUsageSection";

interface AccountSectionProps {
	displayName: string;
	email: string;
	currentMailboxId?: string;
	connectedMailboxes?: Array<{
		id: string;
		name?: string;
		email: string;
		settings?: { fromName?: string };
	}>;
	onChangeMailbox?: () => void;
	isChangingMailbox?: boolean;
}

function initialOf(value: string | undefined): string {
	if (!value) return "?";
	const trimmed = value.trim();
	if (!trimmed) return "?";
	const codePoint = trimmed.codePointAt(0);
	return codePoint
		? String.fromCodePoint(codePoint).toUpperCase()
		: trimmed[0]!.toUpperCase();
}

export function AccountSection({
	displayName,
	email,
	currentMailboxId,
	connectedMailboxes: _connectedMailboxes = [],
	onChangeMailbox,
	isChangingMailbox = false,
}: AccountSectionProps) {
	const queryClient = useQueryClient();
	const [editDialogOpen, setEditDialogOpen] = useState(false);
	const [draftDisplayName, setDraftDisplayName] = useState(displayName);
	const normalizedDisplayName = draftDisplayName.trim();
	const isDisplayNameDirty = normalizedDisplayName !== displayName.trim();

	useEffect(() => {
		setDraftDisplayName(displayName);
	}, [displayName]);

	const updateDisplayName = useMutation({
		mutationFn: () => api.updateAccountDisplayName(normalizedDisplayName),
		onSuccess: ({ account }) => {
			queryClient.setQueryData<AccountCurrentResponse>(["account", "current"], {
				account,
			});
			setDraftDisplayName(account.displayName ?? normalizedDisplayName);
			setEditDialogOpen(false);
			toast.success("发件人名称已更新");
		},
		onError: (error) => {
			toast.error(getUserFacingError(error, "发件人名称更新失败，请稍后重试。"));
		},
	});

	const openDisplayNameEditor = () => {
		setDraftDisplayName(displayName);
		setEditDialogOpen(true);
	};

	const closeDisplayNameEditor = () => {
		if (updateDisplayName.isPending) return;
		setDraftDisplayName(displayName);
		setEditDialogOpen(false);
	};

	return (
		<>
			<div className="space-y-5">
				<h2 className="font-serif-display text-xl font-semibold text-ink">
					账户
				</h2>

				<section aria-labelledby="active-mailbox-title">
					<h3 id="active-mailbox-title" className="mb-2 text-xs text-ink-3">
						当前邮箱
					</h3>
					<div className="flex items-center gap-3 rounded-xl border border-edge bg-paper-2 px-4 py-4">
						<span
							aria-hidden
							className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-coral text-paper text-sm font-semibold"
						>
							{initialOf(draftDisplayName || email)}
						</span>
						<div className="min-w-0 flex-1">
							<div className="truncate text-sm font-semibold text-ink">
								{draftDisplayName || email.split("@")[0]}
							</div>
							<div className="truncate text-xs text-ink-3">{email}</div>
						</div>
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<button
									type="button"
									aria-label="邮箱账户操作"
									className="inline-flex h-9 w-9 items-center justify-center rounded-full text-ink-3 transition-colors hover:bg-paper-3 hover:text-ink focus-visible:outline-2 focus-visible:outline-focus"
								>
									<DotsThreeIcon size={18} weight="bold" />
								</button>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end" className="min-w-[180px]">
								<DropdownMenuItem onSelect={openDisplayNameEditor}>
									<PencilSimpleIcon size={14} />
									编辑发件人名称
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
						<Button
							variant="secondary"
							size="sm"
							onClick={onChangeMailbox}
							loading={isChangingMailbox}
							disabled={!onChangeMailbox}
							className="rounded-full text-xs"
						>
							更换邮箱
						</Button>
					</div>
				</section>

				<AiUsageSection accountId={currentMailboxId} />
			</div>

			<Dialog
				open={editDialogOpen}
				onOpenChange={(open) => {
					if (!open) closeDisplayNameEditor();
				}}
			>
				<DialogContent className="z-[70] max-w-[420px]">
					<form
						className="grid gap-4"
						onSubmit={(event) => {
							event.preventDefault();
							if (normalizedDisplayName && isDisplayNameDirty) {
								updateDisplayName.mutate();
							}
						}}
					>
						<DialogHeader>
							<DialogTitle>编辑发件人名称</DialogTitle>
							<DialogDescription className="sr-only">
								更新当前邮箱的发件人名称。
							</DialogDescription>
						</DialogHeader>
						<div>
							<label htmlFor="sender-display-name" className="mb-1.5 block text-xs font-medium text-ink-2">
								发件人名称
							</label>
							<Input
								id="sender-display-name"
								value={draftDisplayName}
								maxLength={120}
								autoFocus
								aria-invalid={!normalizedDisplayName}
								onChange={(event) => setDraftDisplayName(event.target.value)}
							/>
						</div>
						<DialogFooter>
							<Button type="button" variant="ghost" onClick={closeDisplayNameEditor} disabled={updateDisplayName.isPending}>
								取消
							</Button>
							<Button type="submit" loading={updateDisplayName.isPending} disabled={!normalizedDisplayName || !isDisplayNameDirty}>
								保存
							</Button>
						</DialogFooter>
					</form>
				</DialogContent>
			</Dialog>
		</>
	);
}
