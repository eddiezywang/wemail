import { useState } from "react";
import { toast } from "sonner";
import { ConfirmActionDialog } from "~/components/ui/confirm-action-dialog";
import {
	useAgentLearningPreferences,
	useClearAgentLearning,
	useCorrectAgentLearningPreference,
	useDeleteAgentLearningPreference,
} from "~/queries/agentLearning";

function displayValue(value: unknown): string {
	return typeof value === "string" ? value : JSON.stringify(value);
}

export function AgentLearningPreferences() {
	const preferences = useAgentLearningPreferences();
	const correct = useCorrectAgentLearningPreference();
	const remove = useDeleteAgentLearningPreference();
	const clear = useClearAgentLearning();
	const [editing, setEditing] = useState<string | null>(null);
	const [draft, setDraft] = useState("");
	const [deleteKey, setDeleteKey] = useState<string | null>(null);
	const [clearConfirmOpen, setClearConfirmOpen] = useState(false);

	return (
		<div className="mt-4 border-t border-edge pt-4" data-testid="agent-learning-preferences">
			<div className="flex items-start justify-between gap-4">
				<div>
					<h4 className="text-sm font-medium text-ink">Agent 学到的偏好</h4>
					<p className="mt-1 text-xs leading-5 text-ink-3">
						这里只记录你的输入、修改和真实操作，不记录 Agent 的思考、工具过程或界面展开行为。
					</p>
				</div>
				<button
					type="button"
					disabled={clear.isPending || (preferences.data?.length ?? 0) === 0}
					className="shrink-0 rounded-md border border-red/30 px-2.5 py-1.5 text-xs text-red hover:bg-red/5 disabled:opacity-40"
					onClick={() => setClearConfirmOpen(true)}
				>
					清除学习数据
				</button>
			</div>
			{preferences.isLoading ? <p className="mt-3 text-xs text-ink-3">正在读取…</p> : null}
			{!preferences.isLoading && (preferences.data?.length ?? 0) === 0 ? (
				<p className="mt-3 rounded-lg bg-paper-3 px-3 py-2 text-xs text-ink-3">尚未形成可检查的偏好。</p>
			) : null}
			<div className="mt-3 space-y-2">
				{preferences.data?.map((preference) => (
					<div key={preference.id} className="rounded-lg border border-edge bg-paper px-3 py-2.5">
						<div className="flex items-center justify-between gap-3">
							<div className="min-w-0">
								<div className="truncate text-xs font-medium text-ink">{preference.key}</div>
								<div className="mt-0.5 text-xs text-ink-3">
									置信度 {Math.round(preference.confidence * 100)}% · {preference.provenanceEventIds.length} 条依据
								</div>
							</div>
							<div className="flex gap-1.5">
								<button type="button" className="text-xs text-ink-2 hover:text-ink" onClick={() => { setEditing(preference.key); setDraft(displayValue(preference.value)); }}>修改</button>
								<button type="button" className="min-h-9 px-2 text-xs text-red hover:underline disabled:opacity-50" disabled={remove.isPending} onClick={() => setDeleteKey(preference.key)}>删除</button>
							</div>
						</div>
						{editing === preference.key ? (
							<div className="mt-2 flex gap-2">
								<input aria-label={`修改 ${preference.key}`} value={draft} onChange={(event) => setDraft(event.target.value)} className="min-w-0 flex-1 rounded-md border border-edge bg-paper-2 px-2 py-1.5 text-xs" />
								<button type="button" disabled={correct.isPending || !draft.trim()} className="min-h-9 rounded-md bg-ink px-2.5 text-xs text-paper disabled:opacity-50" onClick={() => { correct.mutate({ key: preference.key, value: draft }, { onSuccess: () => setEditing(null) }); }}>保存</button>
							</div>
						) : <div className="mt-2 break-words text-xs text-ink-2">{displayValue(preference.value)}</div>}
					</div>
				))}
			</div>
			<ConfirmActionDialog
				open={!!deleteKey}
				onOpenChange={(open) => !open && setDeleteKey(null)}
				title="删除这条学习偏好？"
				description={<>删除“{deleteKey}”后，Agent 不再使用这条偏好；对话和邮件不会被删除。</>}
				confirmLabel="删除偏好"
				pending={remove.isPending}
				onConfirm={() => {
					if (!deleteKey) return;
					remove.mutate(deleteKey, { onSuccess: () => setDeleteKey(null) });
				}}
			/>
			<ConfirmActionDialog
				open={clearConfirmOpen}
				onOpenChange={setClearConfirmOpen}
				title="清除全部学习数据？"
				description="Agent 学到的偏好会全部删除；对话和邮件不会被删除。"
				confirmLabel="全部清除"
				pending={clear.isPending}
				onConfirm={() => clear.mutate(undefined, { onSuccess: () => { setClearConfirmOpen(false); toast.success("已清除 Agent 学习数据"); } })}
			/>
		</div>
	);
}
