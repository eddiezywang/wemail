// Copyright (c) 2026 Cloudflare, Inc.
// Modified for WeMail.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

interface EmailPanelHeaderProps {
	subject: string;
	messageCount: number;
	showThreadCount: boolean;
}

export default function EmailPanelHeader({
	subject,
	messageCount,
	showThreadCount,
}: EmailPanelHeaderProps) {
	return (
		<div className="flex min-h-[52px] shrink-0 items-center gap-4 border-b border-edge-3 px-4 py-2 md:px-6">
			<div className="flex min-w-0 flex-1 items-center gap-2">
				<h2
					className="min-w-0 truncate text-[19px] font-semibold leading-6 tracking-[-0.02em] text-ink select-text"
					title={subject}
				>
					{subject}
				</h2>
				{showThreadCount && (
					<span className="inline-flex min-h-7 shrink-0 items-center rounded-full bg-paper-3 px-1.5 text-xs font-medium tabular-nums text-ink-3">
						{messageCount} 封往来
					</span>
				)}
			</div>
		</div>
	);
}
