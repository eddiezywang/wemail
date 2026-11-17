// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { ReactNode } from "react";
import { NavLink as RouterNavLink } from "react-router";
import {
	Tooltip,
	TooltipContent,
	TooltipPortal,
	TooltipTrigger,
} from "~/components/ui/tooltip";

export interface NavLinkProps {
	to: string;
	label: string;
	count?: number;
	atLimit?: boolean;
	icon?: ReactNode;
	end?: boolean;
	/**
	 * Compact icon-rail layout: icon stacked above a tiny label, used by
	 * the narrow Sidebar. The label remains in the DOM for accessibility
	 * and existing test queries — only the visual treatment changes.
	 */
	compact?: boolean;
	onClick?: () => void;
	title?: string;
	"data-folder"?: string;
}

/**
 * WeMail-styled navigation row used inside the Sidebar nav. Composes
 * react-router's `NavLink` so the active state tracks the current URL.
 *
 * Visual (Refined Paper):
 *  - inactive: `text-ink-3 hover:bg-paper-3/70 hover:text-ink-2`
 *  - active:   coral foreground on the existing sidebar surface, keeping
 *              selection feedback consistent without adding another pill.
 *
 * Count rendering:
 *  - omits when `count` is undefined / 0
 *  - renders `{count}+` when `atLimit` is true
 *  - in compact mode renders as a small dot badge in the corner
 */
export function NavLink({
	to,
	label,
	count,
	atLimit,
	icon,
	end,
	compact,
	onClick,
	title,
	"data-folder": dataFolder,
}: NavLinkProps) {
	const countLabel =
		typeof count === "number" && count > 0
			? `${count}${atLimit ? "+" : ""}`
			: null;

	if (compact) {
		return (
			<Tooltip>
				<TooltipTrigger asChild>
					<RouterNavLink
						to={to}
						end={end}
						onClick={onClick}
						data-testid="nav-link"
						data-folder={dataFolder}
						aria-label={label}
						className={({ isActive }) =>
							`group relative flex h-10 items-center justify-center rounded-md transition-colors ${
								isActive
									? "text-coral"
									: "text-ink-3 hover:bg-paper-2 hover:text-ink"
							}`
						}
					>
						{icon ? (
							<span className="relative shrink-0">
								{icon}
								{countLabel ? (
									<span
										aria-hidden
										className="absolute -right-1.5 -top-1 h-2 w-2 rounded-full bg-coral ring-2 ring-paper-3"
									/>
								) : null}
							</span>
						) : null}
						<span className="sr-only">{label}</span>
						{countLabel ? <span className="sr-only">{countLabel} unread</span> : null}
					</RouterNavLink>
				</TooltipTrigger>
				<TooltipPortal>
					<TooltipContent side="right">{title ?? label}</TooltipContent>
				</TooltipPortal>
			</Tooltip>
		);
	}

	return (
		// Sidebar navigation should switch immediately. Route-level View
		// Transitions animate the root from 4px below and make label/folder
		// switches feel like the whole app jitters.
		<RouterNavLink
			to={to}
			end={end}
			onClick={onClick}
			data-testid="nav-link"
			data-folder={dataFolder}
			title={title}
			className={({ isActive }) =>
				// Selected links use the same sidebar surface. The icon is a
				// sibling <span> using `currentColor`, so it flips with the label.
				`relative flex items-center gap-3 py-2.5 px-3 rounded-md text-ui transition-colors ${
					isActive
						? "text-coral"
						: "text-ink-3 hover:bg-paper-3/70 hover:text-ink-2"
				}`
			}
		>
			{icon ? <span className="shrink-0">{icon}</span> : null}
			<span className="truncate flex-1">{label}</span>
			{countLabel ? (
				<span className="text-meta font-medium text-ink-3 tabular-nums">
					{countLabel}
				</span>
			) : null}
		</RouterNavLink>
	);
}

export default NavLink;
