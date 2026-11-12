import { CheckCircleIcon } from "@phosphor-icons/react/CheckCircle";
import { WarningCircleIcon } from "@phosphor-icons/react/WarningCircle";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { getUserFacingError } from "~/lib/user-facing-error";
import { Textarea } from "~/components/ui/textarea";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "~/components/ui/select";
import { useAiProfile, useSaveAiProfile } from "~/queries/aiProfile";
import { useLlmStatus } from "~/queries/llmSettings";
import {
	CUSTOM_INSTRUCTIONS_MAX_LENGTH,
	DEFAULT_TODO_MANAGEMENT_PROMPT,
	TODO_PROMPT_MAX_LENGTH,
} from "../../../../shared/wemail/settings";
import { AgentLearningPreferences } from "./AgentLearningPreferences";

type ResponseStyle = "concise" | "balanced" | "detailed";

const STYLE_INSTRUCTIONS: Record<ResponseStyle, string> = {
	concise: "回复简洁直接，优先给出结论，避免不必要的客套。",
	balanced: "",
	detailed: "回复提供充分背景、清晰步骤和必要的示例。",
};

const LANGUAGES = [
	{ value: "auto", label: "跟随邮件" },
	{ value: "zh-CN", label: "简体中文" },
	{ value: "en", label: "English" },
	{ value: "ja", label: "日本語" },
	{ value: "es", label: "Español" },
];

export function responseStyleFromPreference(value: string | undefined): ResponseStyle {
	if (value === STYLE_INSTRUCTIONS.concise) return "concise";
	if (value === STYLE_INSTRUCTIONS.detailed) return "detailed";
	return "balanced";
}

export function unifiedLanguagePatch(value: string) {
	const stored = value === "auto" ? undefined : value;
	return {
		summaryLanguage: stored,
		todoLanguage: stored,
		composeLanguage: stored,
	};
}

export function AiProfileSection() {
	const { data: profile } = useAiProfile();
	const status = useLlmStatus();
	const save = useSaveAiProfile();
	const [style, setStyle] = useState<ResponseStyle>("balanced");
	const [language, setLanguage] = useState("auto");
	const [requirements, setRequirements] = useState("");
	const [todoPrompt, setTodoPrompt] = useState(DEFAULT_TODO_MANAGEMENT_PROMPT);

	useEffect(() => {
		setStyle(responseStyleFromPreference(profile?.assistantPreference));
		setLanguage(
			profile?.composeLanguage ??
				profile?.summaryLanguage ??
				profile?.todoLanguage ??
				"auto",
		);
		setRequirements(profile?.customInstructions ?? "");
		setTodoPrompt(profile?.todoPrompt?.trim() || DEFAULT_TODO_MANAGEMENT_PROMPT);
	}, [profile]);

	const persist = (
		patch: Parameters<typeof save.mutate>[0],
		success = "已保存",
	) => {
			save.mutate(patch, {
				onSuccess: () => toast.success(success, { duration: 1200 }),
				onError: (error) =>
					toast.error(getUserFacingError(error, "个性化设置保存失败，请稍后重试。")),
		});
	};

	const ready = status.data?.configured === true;

	return (
		<div className="space-y-5">
			<div>
				<h2 className="mb-1 text-base font-semibold text-ink">个性化</h2>
				<p className="text-xs text-ink-3">
					设置 WeMail 的回答风格、语言和其他个人偏好。
				</p>
			</div>

			<div className="flex items-center justify-between rounded-xl border border-edge bg-paper-2 p-4">
				<div>
					<div className="text-sm font-medium text-ink">AI 服务</div>
					<div className="text-xs text-ink-3">
						{ready ? "服务已就绪，可以使用摘要、撰写和 AI 助手。" : "服务尚未就绪，请前往 AI 模型完成配置。"}
					</div>
				</div>
				<span className={`inline-flex items-center gap-1 text-meta ${ready ? "text-green" : "text-coral-2"}`}>
					{ready ? <CheckCircleIcon weight="fill" /> : <WarningCircleIcon weight="fill" />}
					{ready ? "可用" : "需配置"}
				</span>
			</div>

			<section className="space-y-4 rounded-xl border border-edge bg-paper-2 p-4">
				<div>
					<label htmlFor="ai-response-style" className="mb-1.5 block text-sm font-medium text-ink">
						回答风格
					</label>
					<Select
						value={style}
						onValueChange={(value) => {
							const next = value as ResponseStyle;
							setStyle(next);
							persist({ assistantPreference: STYLE_INSTRUCTIONS[next] });
						}}
					>
						<SelectTrigger id="ai-response-style" aria-label="回答风格">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="concise">简洁</SelectItem>
							<SelectItem value="balanced">平衡</SelectItem>
							<SelectItem value="detailed">详细</SelectItem>
						</SelectContent>
					</Select>
				</div>

				<div>
					<label htmlFor="ai-output-language" className="mb-1.5 block text-sm font-medium text-ink">
						输出语言
					</label>
					<Select
						value={language}
						onValueChange={(value) => {
							setLanguage(value);
							persist(unifiedLanguagePatch(value));
						}}
					>
						<SelectTrigger id="ai-output-language" aria-label="输出语言">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{LANGUAGES.map((item) => (
								<SelectItem key={item.value} value={item.value}>
									{item.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<p className="mt-1 text-xs text-ink-3">
						默认跟随当前邮件的语言，通常无需修改。
					</p>
				</div>

				<div>
					<label htmlFor="ai-other-requirements" className="mb-1.5 block text-sm font-medium text-ink">
						其他要求（可选）
					</label>
					<Textarea
						id="ai-other-requirements"
						value={requirements}
						maxLength={CUSTOM_INSTRUCTIONS_MAX_LENGTH}
						rows={4}
						onChange={(event) => setRequirements(event.target.value)}
						onBlur={() => {
							if (requirements.trim() !== (profile?.customInstructions ?? "").trim()) {
								persist({ customInstructions: requirements.trim() });
							}
						}}
						placeholder="例如：涉及技术问题时给出代码示例。"
					/>
					<div className="mt-1 text-right text-xs text-ink-3">
						{requirements.length} / {CUSTOM_INSTRUCTIONS_MAX_LENGTH}
					</div>
				</div>
			</section>

			<section className="space-y-3 rounded-xl border border-edge bg-paper-2 p-4">
				<div className="flex items-start justify-between gap-4">
					<div>
						<label htmlFor="ai-todo-prompt" className="block text-sm font-medium text-ink">
							待办识别规则
						</label>
						<p className="mt-1 text-xs leading-relaxed text-ink-3">
							仅用于独立的待办任务，不会影响邮件摘要和标签。
						</p>
					</div>
					<button
						type="button"
						className="shrink-0 rounded-md border border-edge px-3 py-1.5 text-xs text-ink hover:bg-paper-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						onClick={() => {
							setTodoPrompt(DEFAULT_TODO_MANAGEMENT_PROMPT);
							persist({ todoPrompt: "" }, "已恢复默认待办规则");
						}}
					>
						恢复默认
					</button>
				</div>
				<Textarea
					id="ai-todo-prompt"
					value={todoPrompt}
					maxLength={TODO_PROMPT_MAX_LENGTH}
					rows={16}
					className="resize-y font-mono text-xs leading-relaxed"
					onChange={(event) => setTodoPrompt(event.target.value)}
					onBlur={() => {
						const normalized = todoPrompt.trim();
						if (!normalized) {
							setTodoPrompt(DEFAULT_TODO_MANAGEMENT_PROMPT);
							persist({ todoPrompt: "" }, "已恢复默认待办规则");
							return;
						}
						if (normalized !== (profile?.todoPrompt?.trim() || DEFAULT_TODO_MANAGEMENT_PROMPT)) {
							persist({ todoPrompt: normalized }, "待办规则已保存");
						}
					}}
				/>
				<div className="text-right text-xs text-ink-3">
					{todoPrompt.length} / {TODO_PROMPT_MAX_LENGTH}
				</div>
			</section>

			<details className="rounded-xl border border-edge bg-paper-2 p-4">
				<summary className="cursor-pointer text-sm font-medium text-ink">个性化数据</summary>
				<p className="mt-2 text-xs text-ink-3">
					WeMail 会使用你保存的回答偏好和自然语言要求。账户称呼直接使用当前邮箱的发件人名称，不再单独维护。
				</p>
				<div className="mt-3 flex items-center justify-between gap-3">
					<span className="text-xs text-ink-3">
						{style !== "balanced" || language !== "auto" || requirements.trim()
							? "已应用个性化偏好"
							: "当前使用默认行为"}
					</span>
					<button
						type="button"
						className="rounded-md border border-edge px-3 py-1.5 text-xs text-ink hover:bg-paper-3"
						onClick={() => {
							setStyle("balanced");
							setLanguage("auto");
							setRequirements("");
							persist({
								assistantPreference: "",
								summaryLanguage: undefined,
								todoLanguage: undefined,
								composeLanguage: undefined,
								customInstructions: "",
							}, "已恢复默认个性化设置");
						}}
					>
						恢复默认
					</button>
				</div>
				<AgentLearningPreferences />
			</details>
		</div>
	);
}
