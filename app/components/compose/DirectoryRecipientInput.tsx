import { SpinnerGapIcon } from "@phosphor-icons/react/SpinnerGap";
import { XIcon } from "@phosphor-icons/react/X";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Input } from "~/components/ui/input";
import { parseAddressString, splitEmailList } from "~/lib/utils";
import api from "~/services/api";
import type { DirectoryContactSummary } from "../../../shared/wemail/directory";

const SEARCH_DELAY_MS = 300;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface RecipientToken {
	email: string;
	name?: string;
}

export interface DirectoryRecipientInputProps {
	value: string;
	onChange: (value: string) => void;
	ariaLabel: string;
	disabled?: boolean;
}

export function DirectoryRecipientInput({
	value,
	onChange,
	ariaLabel,
	disabled,
}: DirectoryRecipientInputProps) {
	const listboxId = useId();
	const inputRef = useRef<HTMLInputElement | null>(null);
	const requestIdRef = useRef(0);
	const tokens = useMemo(() => parseRecipientTokens(value), [value]);
	const [query, setQuery] = useState("");
	const [contacts, setContacts] = useState<DirectoryContactSummary[]>([]);
	const [focused, setFocused] = useState(false);
	const [isLoading, setIsLoading] = useState(false);
	const [activeIndex, setActiveIndex] = useState(-1);
	const [searchedQuery, setSearchedQuery] = useState<string | null>(null);
	const [remoteAvailable, setRemoteAvailable] = useState(true);
	const [isComposing, setIsComposing] = useState(false);
	const trimmedQuery = query.trim();

	useEffect(() => {
		requestIdRef.current += 1;
		const requestId = requestIdRef.current;
		setContacts([]);
		setActiveIndex(-1);
		setSearchedQuery(null);
		setRemoteAvailable(true);
		setIsLoading(false);
		if (!focused || !trimmedQuery || isComposing) return;

		const controller = new AbortController();
		const timer = window.setTimeout(() => {
			setIsLoading(true);
			void api.searchDirectoryContacts(trimmedQuery, {
				limit: 8,
				signal: controller.signal,
			})
				.then((result) => {
					if (requestId !== requestIdRef.current) return;
					setContacts(result.contacts);
					setRemoteAvailable(result.remoteAvailable);
					setSearchedQuery(trimmedQuery);
					setActiveIndex(result.contacts.length > 0 ? 0 : -1);
				})
				.catch(() => {
					if (requestId !== requestIdRef.current) return;
					setContacts([]);
					setRemoteAvailable(false);
					setSearchedQuery(trimmedQuery);
					setActiveIndex(-1);
				})
				.finally(() => {
					if (requestId === requestIdRef.current) setIsLoading(false);
				});
		}, SEARCH_DELAY_MS);

		return () => {
			window.clearTimeout(timer);
			controller.abort();
		};
	}, [focused, isComposing, trimmedQuery]);

	const commitTokens = (next: RecipientToken[]) => {
		onChange(serializeRecipientTokens(dedupeTokens(next)));
	};

	const addTokens = (next: RecipientToken[]) => {
		commitTokens([...tokens, ...next]);
		setQuery("");
		setContacts([]);
		setSearchedQuery(null);
		setActiveIndex(-1);
		window.setTimeout(() => inputRef.current?.focus(), 0);
	};

	const addContact = (contact: DirectoryContactSummary) => {
		addTokens([{
			email: contact.email,
			name: contact.name && contact.name !== contact.email ? contact.name : undefined,
		}]);
	};

	const addTypedEmail = (): boolean => {
		const parsed = parseAddressString(trimmedQuery);
		if (!parsed || !isValidEmail(parsed.email)) return false;
		addTokens([{ email: parsed.email, name: parsed.name }]);
		return true;
	};

	const removeToken = (index: number) => {
		commitTokens(tokens.filter((_token, tokenIndex) => tokenIndex !== index));
		window.setTimeout(() => inputRef.current?.focus(), 0);
	};

	const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
		if (event.nativeEvent.isComposing || event.keyCode === 229) return;
		if (event.key === "ArrowDown" && contacts.length > 0) {
			event.preventDefault();
			setActiveIndex((index) => (index + 1 + contacts.length) % contacts.length);
			return;
		}
		if (event.key === "ArrowUp" && contacts.length > 0) {
			event.preventDefault();
			setActiveIndex((index) => (index - 1 + contacts.length) % contacts.length);
			return;
		}
		if (event.key === "Escape") {
			setContacts([]);
			setSearchedQuery(null);
			setActiveIndex(-1);
			return;
		}
		if (event.key === "Backspace" && !query && tokens.length > 0) {
			event.preventDefault();
			removeToken(tokens.length - 1);
			return;
		}
		if (event.key === "Enter" || event.key === "Tab") {
			if (contacts.length > 0 && activeIndex >= 0) {
				event.preventDefault();
				addContact(contacts[activeIndex]!);
				return;
			}
			if (trimmedQuery && addTypedEmail()) {
				event.preventDefault();
				return;
			}
			if (event.key === "Enter") event.preventDefault();
			return;
		}
		if ((event.key === "," || event.key === ";") && trimmedQuery) {
			if (addTypedEmail()) event.preventDefault();
		}
	};

	const handlePaste = (event: React.ClipboardEvent<HTMLInputElement>) => {
		const text = event.clipboardData.getData("text").trim();
		if (!text) return;
		const parts = text.split(/[;,\r\n]+/).map((part) => part.trim()).filter(Boolean);
		const parsed = parts.map(parseAddressString);
		if (parsed.length === 0 || parsed.some((address) => !address || !isValidEmail(address.email))) {
			return;
		}
		event.preventDefault();
		addTokens(parsed.map((address) => ({
			email: address!.email,
			name: address!.name,
		})));
	};

	const showPanel = focused && !!trimmedQuery && (
		isLoading || searchedQuery === trimmedQuery
	);

	return (
		<div className="relative min-w-0 flex-1">
			<div
				className="flex min-h-8 w-full flex-wrap items-center gap-1.5 rounded-md border-b border-edge px-0.5 transition-[border-color,background-color] duration-150 focus-within:border-coral focus-within:bg-paper-2/70"
				onMouseDown={(event) => {
					if (event.target === event.currentTarget) inputRef.current?.focus();
				}}
			>
				{tokens.map((token, index) => {
					const label = token.name || token.email;
					return (
						<span
							key={`${token.email.toLowerCase()}-${index}`}
							className="inline-flex max-w-56 items-center gap-1 rounded-full border border-edge-3 bg-paper-2 py-1 pl-2.5 pr-1 text-xs text-ink"
							title={token.email}
						>
							<span className="truncate font-medium">{label}</span>
							<button
								type="button"
								className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-ink-3 hover:bg-paper-3 hover:text-ink"
								onClick={() => removeToken(index)}
								aria-label={`移除${ariaLabel} ${label}`}
								disabled={disabled}
							>
								<XIcon size={10} />
							</button>
						</span>
					);
				})}
				<Input
					ref={inputRef}
					value={query}
					onChange={(event) => setQuery(event.target.value)}
					onFocus={() => setFocused(true)}
					onBlur={() => window.setTimeout(() => setFocused(false), 100)}
					onCompositionStart={() => setIsComposing(true)}
					onCompositionEnd={() => setIsComposing(false)}
					onKeyDown={handleKeyDown}
					onPaste={handlePaste}
					aria-label={ariaLabel}
					role="combobox"
					aria-autocomplete="list"
					aria-expanded={showPanel}
					aria-controls={listboxId}
					aria-activedescendant={activeIndex >= 0 ? `${listboxId}-${activeIndex}` : undefined}
					disabled={disabled}
					className="h-9 min-w-28 flex-1 border-0 bg-transparent px-1 py-0 text-sm shadow-none focus-visible:border-0 focus-visible:ring-0"
				/>
				{isLoading ? (
					<SpinnerGapIcon size={14} className="mr-1 shrink-0 animate-spin text-ink-3 motion-reduce:animate-none" aria-label="正在搜索企业通讯录" />
				) : null}
			</div>

			{showPanel ? (
				<div
					id={listboxId}
					role="listbox"
					className="absolute left-0 right-0 top-full z-50 mt-1 overflow-hidden rounded-lg border border-edge bg-paper shadow-lg"
				>
					{isLoading ? (
						<div className="px-3 py-2.5 text-xs text-ink-3">正在搜索企业通讯录…</div>
					) : contacts.length > 0 ? (
						contacts.map((contact, index) => (
							<button
								key={contact.email.toLowerCase()}
								id={`${listboxId}-${index}`}
								type="button"
								role="option"
								aria-selected={index === activeIndex}
								onMouseDown={(event) => event.preventDefault()}
								onMouseEnter={() => setActiveIndex(index)}
								onClick={() => addContact(contact)}
								className={`flex w-full items-start justify-between gap-3 px-3 py-2.5 text-left ${
									index === activeIndex ? "bg-paper-2" : "hover:bg-paper-2"
								}`}
							>
								<span className="min-w-0">
									<span className="block truncate text-sm font-medium text-ink">{contact.name}</span>
									<span className="block truncate text-xs text-ink-3">{contact.email}</span>
								</span>
								<span className="max-w-56 truncate pt-0.5 text-xs text-ink-3">
									{contact.departmentPath ?? contact.title ?? "企业通讯录"}
								</span>
							</button>
						))
					) : (
						<div className="px-3 py-2.5 text-xs text-ink-3">
							{remoteAvailable ? "未找到联系人" : "企业通讯录暂时不可用，可直接输入邮箱"}
						</div>
					)}
				</div>
			) : null}
		</div>
	);
}

function parseRecipientTokens(value: string): RecipientToken[] {
	const tokens: RecipientToken[] = [];
	for (const entry of splitEmailList(value)) {
		const parsed = parseAddressString(entry);
		if (!parsed) continue;
		tokens.push({
			email: parsed.email,
			...(parsed.name ? { name: parsed.name } : {}),
		});
	}
	return dedupeTokens(tokens);
}

function dedupeTokens(tokens: RecipientToken[]): RecipientToken[] {
	const deduped: RecipientToken[] = [];
	const positions = new Map<string, number>();
	for (const token of tokens) {
		const email = token.email.trim();
		if (!email) continue;
		const key = email.toLowerCase();
		const existingIndex = positions.get(key);
		if (existingIndex === undefined) {
			positions.set(key, deduped.length);
			deduped.push({ email, name: token.name?.trim() || undefined });
		} else if (!deduped[existingIndex]!.name && token.name?.trim()) {
			deduped[existingIndex] = { ...deduped[existingIndex]!, name: token.name.trim() };
		}
	}
	return deduped;
}

function serializeRecipientTokens(tokens: RecipientToken[]): string {
	return tokens.map((token) => token.name
		? `${token.name} <${token.email}>`
		: token.email).join(", ");
}

function isValidEmail(value: string): boolean {
	return EMAIL_PATTERN.test(value.trim());
}
