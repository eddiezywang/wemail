// Copyright (c) 2026 Cloudflare, Inc.
// Modified for WeMail.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useEffect, useState } from "react";
import { CircleNotchIcon } from "@phosphor-icons/react/CircleNotch";
import { PaperPlaneTiltIcon } from "@phosphor-icons/react/PaperPlaneTilt";
import { useSendStatusStore } from "~/hooks/useSendStatusStore";

/**
 * Fog-style top-center send-status pill: spinner + 正在发送 + 撤销 during the
 * undo window, then paper-plane 正在发送, then a brief 已加入发件队列. Enters
 * once on mount (150/120ms, UI ease); only transform/opacity animate.
 */
export function SendStatusCapsule() {
	const phase = useSendStatusStore((s) => s.phase);
	const onUndo = useSendStatusStore((s) => s.onUndo);
	const [entered, setEntered] = useState(false);

	useEffect(() => {
		const id = requestAnimationFrame(() => setEntered(true));
		return () => cancelAnimationFrame(id);
	}, []);

	if (!phase) return null;

	return (
		<div
			role="status"
			aria-live="polite"
			className="fixed left-1/2 top-3 z-[60] -translate-x-1/2"
			data-testid="send-status-capsule"
			data-phase={phase}
		>
			<div
				className={`flex items-center gap-2.5 rounded-full border border-edge bg-paper-2/95 px-4 py-2 text-ui shadow-[var(--shadow-3)] backdrop-blur
					transition-[opacity,transform] duration-200 ease-[cubic-bezier(.2,.8,.2,1)]
					motion-reduce:transition-none ${entered ? "opacity-100 translate-y-0" : "opacity-0 -translate-y-2"}`}
			>
				{phase === "hold" ? (
					<>
						<CircleNotchIcon size={14} weight="bold" className="shrink-0 animate-spin motion-reduce:animate-none text-ink/60" />
						<span className="font-medium text-ink">正在发送</span>
						{onUndo ? (
							<>
								<span className="h-3.5 w-px bg-edge" aria-hidden />
								<button
									type="button"
									onClick={onUndo}
									className="rounded-full px-1 font-medium text-coral transition-transform duration-[90ms] hover:opacity-80 active:scale-[.985]"
									data-testid="send-undo"
								>
									撤销
								</button>
							</>
						) : null}
					</>
				) : (
					<>
						<PaperPlaneTiltIcon size={14} weight="fill" className="shrink-0 text-ink/60" />
						<span className="font-medium text-ink">{phase === "delivering" ? "正在发送" : "已加入发件队列"}</span>
					</>
				)}
			</div>
		</div>
	);
}
