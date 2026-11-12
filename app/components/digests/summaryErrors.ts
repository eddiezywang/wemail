// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type {
	SummaryHealthItem,
	SummaryWorkState,
} from "shared/wemail/intelligence";

/**
 * Friendly copy for known queue/worker error codes so a stuck "排队中" or
 * "失败" row explains WHY without exposing raw internals. Unknown codes
 * fall back to the raw code so the user still sees the diagnosis.
 */
const KNOWN_ERROR_MESSAGES: Record<string, string> = {
	"llm-not-configured": "模型未配置，请先在设置中配置模型",
	"llm-http-400": "模型请求被拒绝（400），请检查模型接口地址与协议是否匹配",
	"llm-http-401": "模型鉴权失败（401）",
	"llm-http-403": "模型无权限（403）",
	"llm-http-429": "模型限流（429），稍后自动重试",
	"llm-http-408": "模型请求超时（408）",
	"llm-http-500": "模型服务异常（500）",
	"llm-http-502": "模型网关异常（502）",
	"llm-http-503": "模型服务不可用（503）",
	"llm-http-504": "模型网关超时（504）",
	"model-credential-cooldown": "模型凭证冷却中",
	"model-unreachable": "模型服务不可达",
	"lease-expired": "任务执行超时，已释放",
	"ai-source-content-pending": "邮件正文尚未同步完成",
	"invalid-ai-job-payload": "任务数据无效",
	"content-empty": "邮件内容为空，无法生成摘要",
	"invalid-mail-digest-json": "模型返回内容无法解析",
	"invalid-mail-digest-result": "模型返回内容不符合格式",
	TRUNCATED_STRUCTURED_OUTPUT: "模型输出额度不足，结构化结果未生成完整",
};

export function formatSummaryTaskError(item: SummaryHealthItem): string {
	const raw = item.error ?? item.job?.error ?? null;
	const detail = raw ? KNOWN_ERROR_MESSAGES[raw] ?? raw : null;
	switch (item.state) {
		case "failed":
			return detail ? `失败：${detail}` : "摘要生成失败，可重试";
		case "invalid":
			return "摘要内容无效，可重新生成";
		case "missing":
			return "尚未生成摘要";
		case "pending":
			return detail ? `排队中：${detail}` : "任务已入队，等待处理";
		case "running":
			return detail ? `生成中：${detail}` : "任务正在生成摘要";
		case "skipped":
			return "本次任务已跳过";
		default:
			return "-";
	}
}

export function formatSummaryErrorDetail(item: SummaryHealthItem): string | null {
	const raw = item.error ?? item.job?.error ?? null;
	if (!raw) return null;
	return KNOWN_ERROR_MESSAGES[raw] ?? raw;
}

export function getSummaryStateReason(state: SummaryWorkState): string {
	if (state === "failed") return "摘要生成失败，可以重试。";
	if (state === "invalid") return "生成的摘要内容无效，可以重新生成。";
	if (state === "missing") return "这封邮件尚未生成摘要。";
	if (state === "pending") return "任务已进入队列，等待模型处理。";
	if (state === "running") return "任务正在生成摘要。";
	if (state === "skipped") return "本次摘要任务已跳过。";
	return "没有需要处理的问题。";
}
