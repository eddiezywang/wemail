// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { ArrowSquareOutIcon } from "@phosphor-icons/react/ArrowSquareOut";
import { LinkIcon } from "@phosphor-icons/react/Link";
import { WarningIcon } from "@phosphor-icons/react/Warning";
import type { LinkExtractionResult } from "shared/wemail/intelligence";
import { handleExternalLinkClick } from "~/lib/external-links";
import type { IntelligenceStatus } from "~/types/wemail";

export interface EmailSmartLinksCardProps {
	status: IntelligenceStatus | undefined;
	result: LinkExtractionResult | undefined;
}

const CATEGORY_LABEL: Record<string, string> = {
	action: "操作",
	subscribe: "订阅",
	unsubscribe: "退订",
	confirm: "确认",
	download: "下载",
	navigate: "前往",
	payment: "支付",
	meeting: "会议",
	approval: "审批",
	document: "文档",
};

export function EmailSmartLinksCard({ status, result }: EmailSmartLinksCardProps) {
	const links = result?.links ?? [];
	if (status === "succeeded" && links.length === 0 && !result?.unsubscribeUrl) {
		return null;
	}
	if (!status || status === "skipped") return null;

	return (
		<section
			data-testid="email-smart-links-card"
			className="rounded-md border border-edge bg-paper-2 p-3 text-sm"
		>
			<header className="flex items-center gap-2 pb-2">
				<LinkIcon size={14} weight="bold" className="text-coral" />
				<span className="text-xs font-semibold uppercase tracking-wide text-ink-3">
					智能链接
				</span>
				{status === "pending" || status === "running" ? (
					<span className="text-xs text-ink-3">分析中…</span>
				) : null}
			</header>
			{status === "failed" ? (
				<p className="text-ink-2 text-xs">链接解析失败。</p>
			) : null}
			{result?.unsubscribeUrl ? (
				<a
					href={result.unsubscribeUrl}
					rel="noreferrer"
					onClick={(event) =>
						handleExternalLinkClick(event.nativeEvent, result.unsubscribeUrl)
					}
					className="mb-2 inline-flex items-center gap-1 rounded-full border border-edge bg-paper px-2.5 py-1 text-xs text-ink-2 hover:bg-paper-3"
				>
					<ArrowSquareOutIcon size={12} weight="bold" />
					一键退订
				</a>
			) : null}
			{links.length > 0 ? (
				<ul className="space-y-1 select-text">
					{links.map((link, idx) => (
						<li key={`${link.url}-${idx}`}>
							<a
								href={link.url}
								rel="noreferrer"
								onClick={(event) =>
									handleExternalLinkClick(event.nativeEvent, link.url)
								}
								className={`flex items-center gap-2 rounded-md px-2 py-1 text-xs transition-colors hover:bg-paper-3 ${
									link.risk ? "text-coral" : "text-ink"
								}`}
							>
								{link.risk ? (
									<WarningIcon size={12} weight="bold" />
								) : (
									<LinkIcon size={12} weight="regular" />
								)}
								<span className="flex-1 truncate">{link.actionText}</span>
								<span className="text-xs uppercase tracking-wide text-ink-3">
									{CATEGORY_LABEL[link.category] ?? link.category}
								</span>
							</a>
						</li>
					))}
				</ul>
			) : null}
		</section>
	);
}

export default EmailSmartLinksCard;
