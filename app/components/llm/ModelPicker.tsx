import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { CheckIcon } from "@phosphor-icons/react/Check";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/MagnifyingGlass";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { DiscoveredLlmModel } from "~/services/api";
import { Input } from "~/components/ui/input";
import {
	Popover,
	PopoverAnchor,
	PopoverContent,
} from "~/components/ui/popover";
import { cn } from "~/lib/cn";

export interface ModelPickerProps {
	id?: string;
	value: string;
	onChange: (value: string) => void;
	models?: DiscoveredLlmModel[];
	placeholder?: string;
	disabled?: boolean;
	status?: "idle" | "loading" | "success" | "error";
	showStatus?: boolean;
}

export function ModelPicker({
	id,
	value,
	onChange,
	models = [],
	placeholder = "搜索或输入模型 ID",
	disabled,
	status = "idle",
	showStatus = false,
}: ModelPickerProps) {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [activeIndex, setActiveIndex] = useState(0);
	const controlRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const listboxId = useId();
	const normalizedQuery = query.trim().toLocaleLowerCase();
	const filtered = useMemo(
		() => models.filter((model) =>
			!normalizedQuery || model.id.toLocaleLowerCase().includes(normalizedQuery)),
		[models, normalizedQuery],
	);
	const customQuery = query.trim();
	const queryMatchesModel = models.some((model) => model.id === customQuery);
	const hasCustomOption = Boolean(customQuery && !queryMatchesModel);
	const optionCount = filtered.length + (hasCustomOption ? 1 : 0);
	const customOptionIndex = filtered.length;

	useEffect(() => {
		if (!open) return;
		const selectedIndex = filtered.findIndex((model) => model.id === value);
		setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0);
	}, [filtered, open, value]);

	useEffect(() => {
		setActiveIndex((current) => Math.min(current, Math.max(optionCount - 1, 0)));
	}, [optionCount]);

	const openList = () => {
		if (disabled) return;
		setQuery("");
		setOpen(true);
	};
	const selectModel = (modelId: string) => {
		onChange(modelId);
		setQuery("");
		setOpen(false);
		inputRef.current?.focus();
	};
	const targetIsControl = (event: Event) =>
		controlRef.current?.contains(event.target as Node) ?? false;

	return (
		<div className="space-y-1">
			<Popover open={open} onOpenChange={setOpen}>
				<PopoverAnchor asChild>
					<div ref={controlRef} className="relative">
						<MagnifyingGlassIcon
							size={14}
							className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-3"
						/>
						<Input
							id={id}
							ref={inputRef}
							role="combobox"
							aria-expanded={open}
							aria-controls={listboxId}
							aria-autocomplete="list"
							aria-activedescendant={
								open && optionCount > 0
									? `${listboxId}-option-${activeIndex}`
									: undefined
							}
							value={value}
							onChange={(event) => {
								onChange(event.target.value);
								setQuery(event.target.value);
								setOpen(true);
							}}
							onFocus={openList}
							onClick={openList}
							onKeyDown={(event) => {
								if (event.key === "ArrowDown") {
									event.preventDefault();
									if (!open) openList();
									else setActiveIndex((current) =>
										Math.min(current + 1, Math.max(optionCount - 1, 0)));
								} else if (event.key === "ArrowUp") {
									event.preventDefault();
									if (!open) openList();
									else setActiveIndex((current) => Math.max(current - 1, 0));
								} else if (event.key === "Enter" && open) {
									if (filtered[activeIndex]) {
										event.preventDefault();
										selectModel(filtered[activeIndex].id);
									} else if (hasCustomOption && activeIndex === customOptionIndex) {
										event.preventDefault();
										selectModel(customQuery);
									}
								} else if (event.key === "Home" && open) {
									event.preventDefault();
									setActiveIndex(0);
								} else if (event.key === "End" && open) {
									event.preventDefault();
									setActiveIndex(Math.max(optionCount - 1, 0));
								} else if (event.key === "Escape") {
									event.preventDefault();
									setOpen(false);
								} else if (event.key === "Tab") {
									setOpen(false);
								}
							}}
							placeholder={placeholder}
							disabled={disabled}
							className="pl-9 pr-9 font-mono-meta text-xs"
						/>
						<button
							type="button"
							aria-label="显示模型列表"
							onMouseDown={(event) => event.preventDefault()}
							onClick={() => {
								if (open) {
									setOpen(false);
									return;
								}
								openList();
								inputRef.current?.focus();
							}}
							disabled={disabled}
							className="absolute inset-y-0 right-0 grid w-9 place-items-center text-ink-3 hover:text-ink disabled:opacity-50"
						>
							<CaretDownIcon
								size={14}
								className={cn("transition-transform", open && "rotate-180")}
							/>
						</button>
					</div>
				</PopoverAnchor>
				<PopoverContent
					align="start"
					sideOffset={4}
					onOpenAutoFocus={(event) => event.preventDefault()}
					onCloseAutoFocus={(event) => event.preventDefault()}
					onInteractOutside={(event) => {
						if (targetIsControl(event)) event.preventDefault();
					}}
					onFocusOutside={(event) => {
						if (targetIsControl(event)) event.preventDefault();
					}}
					className="w-[var(--radix-popover-trigger-width)] min-w-64 p-1.5"
				>
					<div
						id={listboxId}
						role="listbox"
						className="max-h-56 overflow-y-auto"
						onWheel={(event) => {
							// The picker is commonly opened from inside a modal Dialog.
							// Radix's dialog scroll lock sees this portalled list as
							// outside the dialog and prevents the browser's native wheel
							// scrolling. Apply the delta directly so a mouse/trackpad can
							// still move through a long discovered-model list.
							const list = event.currentTarget;
							const maxTop = Math.max(0, list.scrollHeight - list.clientHeight);
			const nextTop = Math.min(maxTop, Math.max(0, list.scrollTop + event.deltaY));
			if (nextTop !== list.scrollTop) {
				event.preventDefault();
				list.scrollTop = nextTop;
			}
						}}
					>
						{filtered.length > 0 ? (
							<>
								<div className="px-2 py-1 text-xs font-medium uppercase tracking-wider text-ink-3">
									已发现模型
								</div>
								{filtered.map((model, index) => {
									const selected = model.id === value;
									return (
										<button
											id={`${listboxId}-option-${index}`}
											type="button"
											role="option"
											aria-selected={selected}
											key={model.id}
											onMouseDown={(event) => event.preventDefault()}
											onMouseEnter={() => setActiveIndex(index)}
											onClick={() => selectModel(model.id)}
											className={cn(
												"flex w-full items-center gap-2 rounded-sm px-2 py-2 text-left transition-colors hover:bg-paper-3",
												(selected || activeIndex === index) && "bg-paper-3",
											)}
										>
											<span className="min-w-0 flex-1 truncate font-mono-meta text-xs">
												{model.id}
											</span>
											{model.ownedBy ? (
												<span className="truncate text-xs text-ink-3">{model.ownedBy}</span>
											) : null}
											{selected ? <CheckIcon size={13} weight="bold" className="text-coral" /> : null}
										</button>
									);
								})}
							</>
						) : (
							<div className="px-2 py-4 text-center text-xs text-ink-3">
								{status === "loading" ? "正在获取模型…" : "没有匹配的已发现模型"}
							</div>
						)}
						{hasCustomOption ? (
							<button
								id={`${listboxId}-option-${customOptionIndex}`}
								type="button"
								role="option"
								aria-selected={value === customQuery}
								onMouseDown={(event) => event.preventDefault()}
								onMouseEnter={() => setActiveIndex(customOptionIndex)}
								onClick={() => selectModel(customQuery)}
								className={cn(
									"mt-1 flex w-full items-center border-t border-edge px-2 py-2 text-left text-xs text-coral hover:bg-coral/5",
									activeIndex === customOptionIndex && "bg-coral/5",
								)}
							>
								使用“{customQuery}”作为自定义模型 ID
							</button>
						) : null}
					</div>
				</PopoverContent>
			</Popover>
			{showStatus ? (
				<p className={cn("text-xs text-ink-3", status === "error" && "text-amber")}>
					{status === "loading" ? "正在获取可用模型…" : null}
					{status === "success" ? `已发现 ${models.length} 个模型` : null}
					{status === "error" ? "未能获取模型列表，可直接输入模型 ID" : null}
					{status === "idle" ? "可直接输入模型 ID" : null}
				</p>
			) : null}
		</div>
	);
}
