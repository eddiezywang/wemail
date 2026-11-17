// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Singleton command registry that powers the command palette and
 * `useGlobalShortcuts`. Both are pure-frontend; consumers register
 * commands on mount via `<CommandPaletteRegistrar />` and unregister
 * on unmount.
 *
 * A command is the *thing the user wants to do* (e.g. "Reply to this
 * email"). Mapping a key combo or palette entry onto that command is
 * the responsibility of the consumer (the global keydown listener and
 * the palette UI). Keeping the registry deliberately dumb means we can
 * later add tests, mocks, or alternative shortcut schemes (upstream vs
 * Gmail) without touching the underlying commands.
 */

export interface Command {
	id: string;
	title: string;
	/** Free-form section name used to group items in the palette UI. */
	section?: string;
	/**
	 * Normalised shortcut string (e.g. "r", "shift+r", "mod+k"). Tokens
	 * are lower-case, separated by `+`. The `mod` token resolves to
	 * `Cmd` on macOS and `Ctrl` elsewhere — see
	 * `app/hooks/useGlobalShortcuts.ts` for the matcher.
	 */
	shortcut?: string;
	handler: () => void;
	/**
	 * Optional context predicate. When it returns false the command is
	 * still listed in the palette (greyed out by the UI) but the
	 * shortcut won't fire and the palette won't dispatch it on Enter.
	 */
	when?: () => boolean;
}

type Listener = () => void;

const commands = new Map<string, Command>();
const listeners = new Set<Listener>();
let commandsSnapshot: Command[] = [];

function refreshSnapshot(): void {
	commandsSnapshot = Array.from(commands.values());
}

function notify(): void {
	for (const listener of listeners) listener();
}

/**
 * Register a command. Returns an unsubscribe function so callers (e.g.
 * a registrar component) can clean up on unmount without tracking ids
 * separately. Re-registering the same `id` overwrites the previous
 * command — useful for HMR and for swapping command shortcut schemes.
 */
export function registerCommand(cmd: Command): () => void {
	commands.set(cmd.id, cmd);
	refreshSnapshot();
	notify();
	return () => {
		// Only remove if it's still the same command we registered. This
		// guards against a stale unsubscribe destroying a command that a
		// later mount replaced under the same id.
		if (commands.get(cmd.id) === cmd) {
			commands.delete(cmd.id);
			refreshSnapshot();
			notify();
		}
	};
}

export function unregisterCommand(id: string): void {
	if (commands.delete(id)) {
		refreshSnapshot();
		notify();
	}
}

export function listCommands(): Command[] {
	return commandsSnapshot;
}

export function findById(id: string): Command | undefined {
	return commands.get(id);
}

/**
 * Subscribe to registry changes — used by the palette UI so newly
 * registered commands appear without remounting. Returns an
 * unsubscribe function.
 */
export function subscribe(listener: Listener): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/**
 * Test/HMR helper: clears every command. Not exported through any
 * barrel; direct importers should know what they're doing.
 */
export function _clearAllCommandsForTesting(): void {
	commands.clear();
	refreshSnapshot();
	notify();
}
