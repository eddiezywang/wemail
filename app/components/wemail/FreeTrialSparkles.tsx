// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * 免费额度的"闪闪"氛围层：shimmer 扫光 + 交错星芒。
 * 纯装饰（aria-hidden），reduced-motion 时由 CSS 自动静止。
 * 用法：放在 `relative overflow-hidden` 的卡片内。
 */
export function FreeTrialShimmer({ slow = false }: { slow?: boolean }) {
	return (
		<span
			aria-hidden="true"
			className={`free-trial-shimmer${slow ? " free-trial-shimmer--slow" : ""}`}
		/>
	);
}

export function FreeTrialSparkles({ count = 3 }: { count?: number }) {
	return (
		<span aria-hidden="true" className="free-trial-sparkles">
			{Array.from({ length: count }, (_, index) => (
				<svg
					key={index}
					viewBox="0 0 12 12"
					className="free-trial-sparkle"
					style={{ animationDelay: `${index * 0.9}s` }}
				>
					<path
						d="M6 0 L7.15 4.85 L12 6 L7.15 7.15 L6 12 L4.85 7.15 L0 6 L4.85 4.85 Z"
						fill="currentColor"
					/>
				</svg>
			))}
		</span>
	);
}
