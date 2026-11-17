// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

export default function WMark({
	size = 18,
	className,
}: {
	size?: number;
	className?: string;
}) {
	return (
		<img
			src="/ai-panel-logo.png"
			alt=""
			aria-hidden="true"
			width={size}
			height={size}
			className={className}
		/>
	);
}
