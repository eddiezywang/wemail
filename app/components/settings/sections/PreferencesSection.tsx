// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useEffect, useState } from "react";
import { toast } from "sonner";

type WindowCloseBehavior = "tray" | "exit";

export function PreferencesSection() {
	const [closeBehavior, setCloseBehavior] = useState<WindowCloseBehavior>("tray");
	const [savingCloseBehavior, setSavingCloseBehavior] = useState(false);

	useEffect(() => {
		const getCloseBehavior = window.wemailDesktop?.window?.getCloseBehavior;
		if (typeof getCloseBehavior !== "function") return;
		void getCloseBehavior().then(setCloseBehavior).catch(() => undefined);
	}, []);

	const updateCloseBehavior = async (value: WindowCloseBehavior) => {
		const bridge = window.wemailDesktop?.window;
		setCloseBehavior(value);
		if (!bridge || typeof bridge.setCloseBehavior !== "function") return;
		setSavingCloseBehavior(true);
		try {
			const result = await bridge.setCloseBehavior(value);
			setCloseBehavior(result.value);
			if (!result.ok) toast.error("关闭行为保存失败，请稍后重试。");
		} catch {
			toast.error("关闭行为保存失败，请稍后重试。");
		} finally {
			setSavingCloseBehavior(false);
		}
	};
	return (
		<div className="space-y-4">
			<div>
				<h2 className="mb-1 text-base font-semibold text-ink">用户偏好</h2>
				<p className="text-xs text-ink-3">
					管理窗口行为等个性化偏好。
				</p>
			</div>
			<section className="border-t border-edge pt-4">
				<h3 className="text-sm font-semibold text-ink">关闭窗口时</h3>
				<p className="mt-1 text-xs text-ink-3">选择标题栏关闭按钮的实际行为。</p>
				<div
					className="mt-3 grid gap-2 @min-[520px]/settings-section:grid-cols-2"
					role="radiogroup"
					aria-label="关闭窗口行为"
				>
					{([
						["tray", "最小化到系统托盘", "继续在后台同步邮件"],
						["exit", "退出 WeMail", "停止后台同步并退出应用"],
					] as const).map(([value, label, description]) => (
						<button
							key={value}
							type="button"
							role="radio"
							aria-checked={closeBehavior === value}
							disabled={savingCloseBehavior}
							onClick={() => void updateCloseBehavior(value)}
							className={`min-h-16 rounded-lg border px-3 py-2 text-left transition-colors ${closeBehavior === value ? "border-coral bg-coral-bg" : "border-edge bg-paper-2 hover:bg-paper-3"}`}
						>
							<span className="block text-sm font-medium text-ink">{label}</span>
							<span className="mt-0.5 block text-xs text-ink-3">{description}</span>
						</button>
					))}
				</div>
			</section>
		</div>
	);
}
