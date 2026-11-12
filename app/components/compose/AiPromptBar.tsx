// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { ArrowLeftIcon } from "@phosphor-icons/react/ArrowLeft";
import { ArrowRightIcon } from "@phosphor-icons/react/ArrowRight";
import { ClockCounterClockwiseIcon } from "@phosphor-icons/react/ClockCounterClockwise";
import { MagicWandIcon } from "@phosphor-icons/react/MagicWand";
import { PaperPlaneTiltIcon } from "@phosphor-icons/react/PaperPlaneTilt";
import { GearSixIcon } from "@phosphor-icons/react/GearSix";
import { SparkleIcon } from "@phosphor-icons/react/Sparkle";
import {
	forwardRef,
	useEffect,
	useImperativeHandle,
	useMemo,
	useRef,
	useState,
} from "react";
import { toast } from "sonner";
import DOMPurify from "dompurify";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "~/components/ui/select";
import { Textarea } from "~/components/ui/textarea";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { useAiProfile } from "~/queries/aiProfile";
import { useWritingStyles } from "~/queries/writingStyles";
import api from "~/services/api";
import { getUserFacingError } from "~/lib/user-facing-error";
import type { ComposeMailResult } from "../../../shared/wemail/intelligence";
import {
	mergeComposeAiBody,
	splitComposeAiBody,
} from "./composeAiBody";

const LANGUAGES = [
	{ value: "auto", label: "跟随原邮件" },
	{ value: "zh-CN", label: "简体中文" },
	{ value: "zh-TW", label: "繁體中文" },
	{ value: "en", label: "English" },
	{ value: "ja", label: "日本語" },
	{ value: "fr", label: "Français" },
	{ value: "it", label: "Italiano" },
	{ value: "de", label: "Deutsch" },
	{ value: "es", label: "Español" },
];

const QUICK_ACTIONS = [
	{ label: "扩写", intent: "扩写当前邮件，补充必要上下文，但不要编造事实。" },
	{ label: "缩写", intent: "缩短当前邮件，保留核心信息和礼貌语气。" },
	{ label: "重写", intent: "重新组织当前邮件，使其更自然、清晰且可直接发送。" },
	{ label: "修正语法", intent: "只修正当前邮件的语法、拼写和不自然表达。" },
];

interface AiPromptBarProps {
	accountId?: string;
	mode: "new" | "reply" | "reply-all" | "forward";
	originalEmailId: string | undefined;
	currentTo: string;
	currentCc?: string;
	currentBcc?: string;
	currentSubject: string;
	currentBody: string;
	onApply: (result: {
		subject?: string;
		bodyHtml: string;
		to?: string[];
		cc?: string[];
		bcc?: string[];
		suggestedSendAt?: string;
		suggestedSendTimeZone?: string;
	}) => void;
}

export interface AiPromptBarHandle {
	focus: () => void;
}

function markdownToHtml(md: string): string {
	const escaped = md
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
	return escaped
		.split(/\n{2,}/)
		.map((paragraph) => `<p>${paragraph.replace(/\n/g, "<br>")}</p>`)
		.join("");
}

function plainTextFromHtml(html: string): string {
	const withLineBreaks = html
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/(?:p|div|li|blockquote|h[1-6])>/gi, "\n\n");
	if (typeof document === "undefined") {
		return withLineBreaks
			.replace(/<[^>]*>/g, "")
			.replace(/&nbsp;|&#160;/gi, " ")
			.replace(/&amp;/gi, "&")
			.replace(/&lt;/gi, "<")
			.replace(/&gt;/gi, ">")
			.replace(/\n{3,}/g, "\n\n")
			.trim();
	}
	const container = document.createElement("div");
	container.innerHTML = DOMPurify.sanitize(withLineBreaks);
	return (container.textContent ?? "")
		.replace(/\u00a0/g, " ")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function normalizeDraftMarkdown(value: string): string {
	return /<\/?[a-z][^>]*>/i.test(value)
		? plainTextFromHtml(value)
		: value;
}

export const AiPromptBar = forwardRef<AiPromptBarHandle, AiPromptBarProps>(function AiPromptBar({
	accountId,
	mode,
	originalEmailId,
	currentTo,
	currentCc = "",
	currentBcc = "",
	currentSubject,
	currentBody,
	onApply,
}, ref) {
	const [intent, setIntent] = useState("");
	const [styleId, setStyleId] = useState("none");
	const [language, setLanguage] = useState("auto");
	const [pending, setPending] = useState(false);
	const [clarification, setClarification] = useState<string | null>(null);
	const [clarificationIntent, setClarificationIntent] = useState<string | null>(
		null,
	);
	const [promptHistory, setPromptHistory] = useState<string[]>([]);
	const [historyOpen, setHistoryOpen] = useState(false);
	const [versions, setVersions] = useState<string[]>([]);
	const [versionIndex, setVersionIndex] = useState(-1);
	const [changeSummary, setChangeSummary] = useState<string[]>([]);
	const requestControllerRef = useRef<AbortController | null>(null);
	const rootRef = useRef<HTMLDivElement | null>(null);
	const promptRef = useRef<HTMLTextAreaElement | null>(null);

	useImperativeHandle(ref, () => ({
		focus: () => {
			rootRef.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
			promptRef.current?.focus();
		},
	}), []);

	const { data: styles = [] } = useWritingStyles();
	const { data: profile } = useAiProfile();
	const bodyParts = useMemo(
		() => splitComposeAiBody(currentBody),
		[currentBody],
	);
	const hasEditableBody = plainTextFromHtml(bodyParts.editableHtml).length > 0;

	useEffect(() => {
		if (versions.length === 0 && hasEditableBody) {
			setVersions([bodyParts.editableHtml]);
			setVersionIndex(0);
		}
	}, [bodyParts.editableHtml, hasEditableBody, versions.length]);

	const effectiveLanguage =
		language === "auto"
			? profile?.composeLanguage && profile.composeLanguage !== "auto"
				? profile.composeLanguage
				: undefined
			: language;
	const selectedStyleName =
		styleId === "none"
			? "写作风格"
			: `风格：${styles.find((style) => style.id === styleId)?.name ?? "自定义"}`;
	const selectedLanguageName = `输出：${
		LANGUAGES.find((item) => item.value === language)?.label ?? "自动"
	}`;

	const applyDraftToCompose = (
		draft: ComposeMailResult,
		protectedHtml: string,
	) => {
		const generatedHtml = markdownToHtml(normalizeDraftMarkdown(draft.draftMarkdown));
		const bodyHtml = mergeComposeAiBody(generatedHtml, protectedHtml);
		const patch: {
			subject?: string;
			bodyHtml: string;
			to?: string[];
			cc?: string[];
			bcc?: string[];
			suggestedSendAt?: string;
			suggestedSendTimeZone?: string;
		} = { bodyHtml };
		if (draft.subject && draft.subject !== currentSubject) patch.subject = draft.subject;
		patch.to = draft.to;
		patch.cc = draft.cc ?? [];
		patch.bcc = draft.bcc ?? [];
		if (draft.suggestedSendAt) {
			patch.suggestedSendAt = draft.suggestedSendAt;
			patch.suggestedSendTimeZone = draft.suggestedSendTimeZone;
		}
		onApply(patch);
		setChangeSummary(draft.changeSummary ?? []);

		setVersions((existing) => {
			const base =
				versionIndex >= 0
					? existing.slice(0, versionIndex + 1)
					: existing;
			const next = [...base, generatedHtml];
			setVersionIndex(next.length - 1);
			return next;
		});
	};

	const submit = async (
		requestedIntent = intent,
		options?: { styleId?: string },
	) => {
		const trimmed = requestedIntent.trim();
		if (!trimmed) {
			toast.error("先告诉 AI 想写什么");
			return;
		}
		const operationType: "NEW" | "REPLY" = mode === "new" ? "NEW" : "REPLY";
		if (operationType === "REPLY" && !originalEmailId) {
			toast.error("找不到原邮件，无法回信");
			return;
		}

		const protectedSnapshot = splitComposeAiBody(currentBody).protectedHtml;
		const editableSnapshot = splitComposeAiBody(currentBody).editableHtml;
		const conversationalIntent =
			clarification && clarificationIntent
				? [
						`Previous request: ${clarificationIntent}`,
						`AI clarification: ${clarification}`,
						`User answer: ${trimmed}`,
					].join("\n")
				: trimmed;

		setPromptHistory((items) => [
			trimmed,
			...items.filter((item) => item !== trimmed),
		].slice(0, 8));
		setHistoryOpen(false);
		setPending(true);
		const controller = new AbortController();
		requestControllerRef.current = controller;
		try {
			const response = await api.composeDraft({
				operationType,
				intent: conversationalIntent,
				accountId,
				emailId: originalEmailId,
				to: currentTo
					? currentTo
							.split(/[,，;；]/)
							.map((item) => item.trim())
							.filter(Boolean)
					: undefined,
				currentTo: currentTo ? currentTo.split(/[,，;；]/).map((item) => item.trim()).filter(Boolean) : [],
				currentCc: currentCc ? currentCc.split(/[,，;；]/).map((item) => item.trim()).filter(Boolean) : [],
				currentBcc: currentBcc ? currentBcc.split(/[,，;；]/).map((item) => item.trim()).filter(Boolean) : [],
				targetLanguage: effectiveLanguage,
				styleId:
					(options?.styleId ?? styleId) === "none"
						? undefined
						: options?.styleId ?? styleId,
				currentBody: plainTextFromHtml(editableSnapshot) || undefined,
				currentSubject: currentSubject.trim() || undefined,
				clientNow: new Date().toISOString(),
				clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
			}, { signal: controller.signal });

			if (response.draft.status === "needsClarification") {
				const question =
					response.draft.clarification?.questions[0] ??
					"请补充一下希望邮件表达的具体内容。";
				setClarification(question);
				setClarificationIntent(trimmed);
				setIntent("");
				return;
			}

			setClarification(null);
			setClarificationIntent(null);
			applyDraftToCompose(response.draft, protectedSnapshot);
			setIntent("");
		} catch (error) {
			if (
				!(error instanceof DOMException && error.name === "AbortError") &&
				!controller.signal.aborted
			) {
				toast.error(getUserFacingError(error, "AI 生成失败，请稍后重试。"));
			}
		} finally {
			if (requestControllerRef.current === controller) {
				requestControllerRef.current = null;
			}
			setPending(false);
		}
	};

	const showVersion = (nextIndex: number) => {
		if (nextIndex < 0 || nextIndex >= versions.length) return;
		const currentEditable = splitComposeAiBody(currentBody).editableHtml;
		setVersions((items) =>
			items.map((item, index) =>
				index === versionIndex ? currentEditable : item,
			),
		);
		const target = versions[nextIndex];
		onApply({
			bodyHtml: mergeComposeAiBody(target, bodyParts.protectedHtml),
		});
		setVersionIndex(nextIndex);
	};

	return (
		<div ref={rootRef} className="relative shrink-0 border-t border-edge-3 bg-paper px-3 py-2.5">
			{changeSummary.length > 0 ? (
				<div data-testid="compose-ai-change-summary" className="mb-2 rounded-lg bg-paper-3 px-3 py-2 text-xs text-ink-2">
					{changeSummary.join("；")}
				</div>
			) : null}
			{clarification ? (
				<div
					data-testid="compose-ai-clarification"
					className="mb-2 rounded-lg border border-coral/25 bg-coral/5 px-3 py-2 text-xs leading-relaxed text-ink"
				>
					<div className="mb-0.5 font-medium text-coral">AI 需要确认</div>
					{clarification}
				</div>
			) : null}

			{pending ? (
				<div
					data-testid="compose-ai-loading"
					className="mb-2 grid gap-1.5 animate-pulse motion-reduce:animate-none"
				>
					<div className="h-2.5 w-2/3 rounded bg-paper-3" />
					<div className="h-2.5 w-5/6 rounded bg-paper-3" />
				</div>
			) : null}

			<div className="mb-2 flex min-w-0 flex-wrap items-center gap-1.5">
				<div className="relative shrink-0">
					<button
						type="button"
						aria-label="最近对话"
						title="最近对话"
						onClick={() => setHistoryOpen((open) => !open)}
						disabled={promptHistory.length === 0 || pending}
						className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-paper-3 text-ink-3 transition-colors hover:text-ink disabled:opacity-35"
					>
						<ClockCounterClockwiseIcon size={14} />
					</button>
					{historyOpen ? (
						<div className="absolute bottom-9 left-0 z-50 w-72 rounded-xl border border-edge bg-paper p-1.5 shadow-lg">
							<div className="px-2 py-1 text-xs text-ink-3">
								最近对话
							</div>
							{promptHistory.map((prompt) => (
								<button
									key={prompt}
									type="button"
									aria-label={prompt}
									onClick={() => {
										setIntent(prompt);
										setHistoryOpen(false);
									}}
									className="block w-full truncate rounded-lg px-2 py-1.5 text-left text-xs text-ink hover:bg-paper-3"
								>
									{prompt}
								</button>
							))}
						</div>
					) : null}
				</div>

				{hasEditableBody ? (
					<>
					{versions.length > 1 ? (
						<div className="flex shrink-0 items-center rounded-full bg-paper-3 px-1">
							<button
								type="button"
								onClick={() => showVersion(versionIndex - 1)}
								disabled={versionIndex <= 0 || pending}
								aria-label="上一个草稿版本"
								className="rounded-full p-1 text-ink-3 hover:text-ink disabled:opacity-30"
							>
								<ArrowLeftIcon size={13} />
							</button>
							<button
								type="button"
								onClick={() => showVersion(versionIndex + 1)}
								disabled={versionIndex >= versions.length - 1 || pending}
								aria-label="下一个草稿版本"
								className="rounded-full p-1 text-ink-3 hover:text-ink disabled:opacity-30"
							>
								<ArrowRightIcon size={13} />
							</button>
							<span className="px-0.5 text-xs tabular-nums text-ink-3">
								{versionIndex + 1} / {versions.length}
							</span>
						</div>
					) : null}
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<button
								type="button"
								disabled={pending}
								aria-label="优化草稿"
								className="inline-flex min-h-9 shrink-0 items-center gap-1 rounded-full bg-paper-3 px-2.5 text-xs text-ink-2 transition-colors hover:bg-edge-3 hover:text-ink disabled:opacity-40"
							>
								<MagicWandIcon size={13} />
								优化
							</button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="start" side="top" className="w-36 rounded-xl">
							{QUICK_ACTIONS.map((action) => (
								<DropdownMenuItem
									key={action.label}
									onSelect={() => void submit(action.intent)}
									className="rounded-lg text-xs"
								>
									{action.label}
								</DropdownMenuItem>
							))}
						</DropdownMenuContent>
					</DropdownMenu>
					</>
				) : null}

				<div className="flex w-full min-w-0 flex-wrap items-center gap-1.5 min-[460px]:ml-auto min-[460px]:w-auto min-[460px]:shrink-0">
					<div className="min-w-28 flex-1 min-[460px]:w-32 min-[460px]:flex-none">
						<Select
							value={styleId}
							onValueChange={(nextStyle) => {
								setStyleId(nextStyle);
								if (hasEditableBody && nextStyle !== styleId) {
									void submit(
										"使用所选写作风格重写当前邮件，保持事实不变。",
										{ styleId: nextStyle },
									);
								}
							}}
						>
							<SelectTrigger
								aria-label="写作风格"
								className="h-9 rounded-full border-0 bg-paper-3 px-2.5 text-xs shadow-none focus-visible:ring-1"
							>
								<SelectValue>{selectedStyleName}</SelectValue>
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="none">默认风格</SelectItem>
								{styles.map((style) => (
									<SelectItem key={style.id} value={style.id}>
										{style.name}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
					<button
						type="button"
						aria-label="管理写作风格"
						title="管理写作风格"
						onClick={() => {
							window.history.pushState({}, "", "/?compose=styles");
							window.dispatchEvent(new PopStateEvent("popstate"));
						}}
						className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-paper-3 text-ink-3 transition-colors hover:text-ink"
					>
						<GearSixIcon size={13} />
					</button>
					<div className="min-w-28 flex-1 min-[460px]:w-32 min-[460px]:flex-none">
						<Select value={language} onValueChange={setLanguage}>
							<SelectTrigger
								aria-label="输出语言"
								className="h-9 rounded-full border-0 bg-paper-3 px-2.5 text-xs shadow-none focus-visible:ring-1"
							>
								<SelectValue>{selectedLanguageName}</SelectValue>
							</SelectTrigger>
							<SelectContent>
								{LANGUAGES.map((item) => (
									<SelectItem key={item.value} value={item.value}>
										{item.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
				</div>
			</div>

			<div className="relative flex items-end rounded-2xl bg-paper-3 p-1 pl-9 transition-shadow focus-within:ring-2 focus-within:ring-coral/20">
				<SparkleIcon
					size={14}
					weight="fill"
					className="absolute left-3 top-3 text-coral"
				/>
				<div className="relative min-w-0 flex-1">
					<Textarea
						ref={promptRef}
						value={intent}
						onChange={(event) => setIntent(event.target.value)}
						placeholder={
							pending
								? "请稍等…"
								: "让 AI 帮你写邮件，例如：回复已收到，语气正式一点"
						}
						rows={1}
						disabled={pending}
						className="min-h-9 resize-none border-0 bg-transparent px-0 py-2 text-xs shadow-none focus-visible:ring-0"
						onKeyDown={(event) => {
							if (
								event.key === "Enter" &&
								!event.shiftKey &&
								!event.nativeEvent.isComposing &&
								!pending
							) {
								event.preventDefault();
								void submit();
							}
						}}
					/>
				</div>
				<button
					type="button"
					onClick={() => {
						if (pending) {
							requestControllerRef.current?.abort();
							return;
						}
						void submit();
					}}
					disabled={!pending && !intent.trim()}
					className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-ink text-paper transition-transform hover:scale-[1.03] disabled:cursor-not-allowed disabled:opacity-30"
					title={pending ? "停止 AI 生成" : "发送给 AI"}
					aria-label={pending ? "停止 AI 生成" : "发送给 AI"}
				>
					{pending ? (
						<span className="h-3 w-3 rounded-sm border border-current" />
					) : (
						<PaperPlaneTiltIcon size={13} weight="fill" />
					)}
				</button>
			</div>
		</div>
	);
});
