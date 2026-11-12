// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Toaster as SonnerToaster, toast, type ToasterProps } from "sonner";

/**
 * WeMail Toaster (wraps `sonner`'s Toaster).
 *
 * Pre-configures position/theme and applies WeMail token styling to toasts
 * via `toastOptions.classNames`. We intentionally do NOT enable sonner's
 * `richColors` because its built-in success/error/warning/info palette
 * overrides our paper-theme tokens for typed toasts. Type-specific accents
 * are expressed via token-driven left borders instead. The paper theme is
 * the default, so we hard-code `theme="light"` until a dark theme token map
 * exists.
 */

export { toast };

export const Toaster = ({
	position = "bottom-right",
	theme = "light",
	toastOptions,
	...props
}: ToasterProps) => {
	return (
		<SonnerToaster
			position={position}
			theme={theme}
			toastOptions={{
				...toastOptions,
				classNames: {
					toast:
						"group rounded-md border border-edge bg-paper text-ink shadow-[var(--shadow-2)]",
					title: "text-sm font-medium text-ink",
					description: "text-sm text-ink-3",
					actionButton:
						"rounded-md bg-coral px-2 py-1 text-xs font-medium text-paper",
					cancelButton:
						"rounded-md bg-paper-3 px-2 py-1 text-xs font-medium text-ink",
					closeButton: "border-edge bg-paper text-ink-3 hover:text-ink",
					success: "border-l-2 border-l-green",
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
