// Copyright (c) 2026 Cloudflare, Inc.
// Modified for WeMail.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { create } from "zustand";

export type SendStatusPhase = "hold" | "delivering" | "done";

interface SendStatusState {
	/** null = nothing in flight; hold = undo window; delivering = handed to the outbox; done = brief confirmation */
	phase: SendStatusPhase | null;
	/** Epoch ms when the undo window ends (hold phase only). */
	endsAt: number;
	onUndo: (() => void) | null;
	beginHold: (endsAt: number, onUndo: () => void) => void;
	beginDeliver: () => void;
	finishDone: () => void;
	close: () => void;
}

/**
 * Send-progress capsule state (Fog-style top-center pill). The compose hook
 * owns the actual timer and delivery logic; this store only carries what the
 * capsule renders and wires the 撤销 action back to the hook.
 */
export const useSendStatusStore = create<SendStatusState>((set) => ({
	phase: null,
	endsAt: 0,
	onUndo: null,
	beginHold: (endsAt, onUndo) => set({ phase: "hold", endsAt, onUndo }),
	beginDeliver: () => set({ phase: "delivering", onUndo: null }),
	finishDone: () => set({ phase: "done" }),
	close: () => set({ phase: null, onUndo: null }),
}));
