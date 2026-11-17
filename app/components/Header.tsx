// Copyright (c) 2026 Cloudflare, Inc.
// Modified for WeMail.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { ListIcon } from "@phosphor-icons/react/List";
import { useUIStore } from "~/hooks/useUIStore";

/** Floating chrome — mobile hamburger only. */
export default function Header() {
	const toggleSidebar = useUIStore((state) => state.toggleSidebar);
	return (
		<>
			<button
				type="button"
				onClick={toggleSidebar}
				className="absolute left-3 top-3 z-20 md:hidden h-9 w-9 inline-flex items-center justify-center rounded-md bg-paper-2 border border-edge text-ink-2 hover:text-ink shadow-[var(--shadow-2)]"
				aria-label="切换侧栏"
			>
				<ListIcon size={18} />
			</button>
		</>
	);
}
