// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Quiet brand mark for the app title bar — a small saddle-orange tile
 * with an ivory envelope + W fold. Kept as inline SVG (no <img>) so the
 * titlebar wordmark test stays satisfied.
 */
export function BrandMark({
	size = 16,
	className,
}: {
	size?: number;
	className?: string;
}) {
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			width={size}
			height={size}
			viewBox="0 0 256 256"
			role="img"
			aria-label="WeMail"
			className={className}
		>
			<defs>
				<linearGradient id="wm-title-saddle" x1="36" y1="22" x2="224" y2="238" gradientUnits="userSpaceOnUse">
					<stop offset="0" stopColor="#DD682D" />
					<stop offset="0.48" stopColor="#D65A24" />
					<stop offset="1" stopColor="#C94D20" />
				</linearGradient>
				<linearGradient id="wm-title-ivory" x1="128" y1="58" x2="128" y2="198" gradientUnits="userSpaceOnUse">
					<stop stopColor="#FFFFFF" />
					<stop offset="1" stopColor="#FFF9F0" />
				</linearGradient>
			</defs>
			<rect width="256" height="256" rx="58" fill="url(#wm-title-saddle)" />
			<g fill="url(#wm-title-ivory)">
				<path d="M48 61H208C218 61 219 68 212 73L157 128C152 133 148 133 143 129L138 122C132 116 124 116 118 122L111 129C107 133 103 132 99 128L44 73C37 67 39 61 48 61Z" />
				<path d="M35 82C32 82 30 85 30 89V183C30 195 42 199 51 191L99 143L35 82ZM221 82C224 82 226 85 226 89V183C226 195 214 199 205 191L157 143L221 82Z" />
				<path d="M59 195C55 195 55 193 57 191L128 116L199 191C201 193 200 195 197 195H59Z" />
			</g>
			<path
				d="M35 77L106 148L128 126L150 148L221 77"
				fill="none"
				stroke="#D65A24"
				strokeWidth="7"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
			<path
				d="M45 194L128 116L211 194"
				fill="none"
				stroke="#D65A24"
				strokeWidth="7"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
			<path d="M100 142L128 112L156 142L150 149L128 128L106 149Z" fill="#D65A24" />
		</svg>
	);
}
