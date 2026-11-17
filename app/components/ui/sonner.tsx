// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Toaster as SonnerToaster, toast, type ToasterProps } from "sonner";
import { useTheme } from "~/hooks/useTheme";

/**
 * WeMail Toaster (wraps `sonner`'s Toaster).
 *
 * Result toasts: top-centre of the content, ~3s, 16px corners, success on a
 * soft green tile. Transient results only — persistent jobs live in
 * `<JobCenter />`, not here. Theme follows `useTheme()` (the paper theme is
 * the default; dark resolves via the resolved theme attribute).
 */

export { toast };

export const Toaster = ({
	position = "top-center",
	toastOptions,
	...props
}: ToasterProps) => {
	const { resolvedTheme } = useTheme();
	return (
		<SonnerToaster
			position={position}
			theme={resolvedTheme === "dark" ? "dark" : "light"}
			duration={3000}
			toastOptions={{
				...toastOptions,
				classNames: {
					toast:
						"group rounded-xl border border-edge bg-paper px-3.5 py-2.5 text-ink shadow-[var(--shadow-2)]",
					title: "text-sm font-medium text-ink",
					description: "text-sm text-ink-3",
					actionButton:
						"rounded-md bg-coral px-2 py-1 text-xs font-medium text-paper",
					cancelButton:
						"rounded-md bg-paper-3 px-2 py-1 text-xs font-medium text-ink",
					closeButton: "border-edge bg-paper text-ink-3 hover:text-ink",
					success: "border-l-2 border-l-green bg-green-bg text-green",
					error: "border-l-2 border-l-red",
					warning: "border-l-2 border-l-amber",
					info: "border-l-2 border-l-edge",
					...(toastOptions?.classNames ?? {}),
				},
			}}
			{...props}
		/>
	);
};
Toaster.displayName = "Toaster";
