// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useState } from "react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import {
	Dialog,
	DialogTrigger,
	DialogContent,
	DialogHeader,
	DialogFooter,
	DialogTitle,
	DialogDescription,
	DialogClose,
} from "~/components/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuTrigger,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuCheckboxItem,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuLabel,
	DropdownMenuSub,
	DropdownMenuSubTrigger,
	DropdownMenuSubContent,
} from "~/components/ui/dropdown-menu";
import {
	Tooltip,
	TooltipProvider,
	TooltipTrigger,
	TooltipContent,
} from "~/components/ui/tooltip";
import {
	Popover,
	PopoverTrigger,
	PopoverContent,
} from "~/components/ui/popover";
import {
	Select,
	SelectTrigger,
	SelectContent,
	SelectItem,
	SelectValue,
} from "~/components/ui/select";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "~/components/ui/tabs";
import { Switch } from "~/components/ui/switch";
import { Toaster, toast } from "~/components/ui/sonner";
import { useImeComposition } from "~/hooks/useImeComposition";

/**
 * Developer-only component gallery.
 *
 * This route is gated in `app/routes.ts` so it only appears in development
 * builds. It is a screenshot/QA reference — not a marketing page — so the
 * layout is intentionally dense.
 */

const BUTTON_VARIANTS = ["default", "secondary", "ghost", "destructive", "outline"] as const;
const BUTTON_SIZES = ["sm", "md", "lg"] as const;

function Section({
	title,
	children,
}: {
	title: string;
	children: React.ReactNode;
}) {
	return (
		<section className="flex flex-col gap-3">
			<h2 className="font-serif-display text-xl font-semibold text-ink">
				{title}
			</h2>
			<div className="flex flex-col gap-3">{children}</div>
			<hr className="border-edge mt-2" />
		</section>
	);
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div className="grid grid-cols-[8rem_1fr] items-center gap-3">
			<span className="font-mono-meta text-xs uppercase tracking-wide text-ink-3">
				{label}
			</span>
			<div className="flex flex-wrap items-center gap-3">{children}</div>
		</div>
	);
}

function ImeDemoInput() {
	const ime = useImeComposition();
	const [value, setValue] = useState("");
	return (
		<div className="flex flex-col gap-1">
			<Input
				placeholder="Type 你好 to trigger composition"
				value={value}
				onChange={(e) => setValue(e.target.value)}
				onCompositionStart={ime.onCompositionStart}
				onCompositionEnd={ime.onCompositionEnd}
			/>
			<span className="font-mono-meta text-xs text-ink-3">
				isComposing: {String(ime.isComposing)}
			</span>
		</div>
	);
}

export default function ComponentGallery() {
	const [checked, setChecked] = useState(true);
	const [radio, setRadio] = useState("one");
	const [selectValue, setSelectValue] = useState<string | undefined>(undefined);
	const [switchOn, setSwitchOn] = useState(true);

	return (
		<TooltipProvider>
			<div className="mx-auto flex max-w-4xl flex-col gap-8 p-8 bg-paper text-ink">
				<header className="flex flex-col gap-1">
					<h1 className="font-serif-display text-2xl font-semibold">
						WeMail Component Gallery
					</h1>
					<p className="text-sm text-ink-3">
						Dev-only reference at <code className="font-mono-meta">/__dev/components</code>.
						Renders every primitive in default / focus / disabled / invalid /
						loading / destructive variations where applicable.
					</p>
				</header>

				<Section title="Button">
					{BUTTON_VARIANTS.map((variant) => (
						<Row key={variant} label={variant}>
							{BUTTON_SIZES.map((size) => (
								<Button key={`${variant}-${size}`} variant={variant} size={size}>
									{variant} / {size}
								</Button>
							))}
							<Button variant={variant} disabled>
								disabled
							</Button>
							<Button variant={variant} loading>
								loading
							</Button>
							{/* hover-like: simulate hover via the variant's hover bg utility */}
							<Button
								variant={variant}
								className={
									variant === "default"
										? "bg-coral-2"
										: variant === "destructive"
											? "bg-coral-2"
											: "bg-paper-3"
								}
							>
								hover-like
							</Button>
						</Row>
					))}
				</Section>

				<Section title="Input">
					<Row label="default">
						<Input placeholder="default" />
					</Row>
					<Row label="focus">
						{/* focus-like: caller can tab in. We mark with autoFocus only on screenshot pages. */}
						<Input
							placeholder="focus (click me)"
							className="border-coral ring-2 ring-ring"
						/>
					</Row>
					<Row label="invalid">
						<Input aria-invalid="true" defaultValue="bad@" />
					</Row>
					<Row label="disabled">
						<Input disabled defaultValue="disabled" />
					</Row>
					<Row label="ime">
						<ImeDemoInput />
					</Row>
				</Section>

				<Section title="Textarea">
					<Row label="default">
						<Textarea placeholder="Write a draft..." />
					</Row>
					<Row label="invalid">
						<Textarea aria-invalid="true" defaultValue="bad content" />
					</Row>
					<Row label="disabled">
						<Textarea disabled defaultValue="disabled" />
					</Row>
				</Section>

				<Section title="Dialog">
					<Row label="trigger">
						<Dialog>
							<DialogTrigger asChild>
								<Button variant="secondary">Open dialog</Button>
							</DialogTrigger>
							<DialogContent>
								<DialogHeader>
									<DialogTitle>Confirm action</DialogTitle>
									<DialogDescription>
										This is a sample dialog rendered from the gallery.
									</DialogDescription>
								</DialogHeader>
								<DialogFooter>
									<DialogClose asChild>
										<Button variant="ghost">Cancel</Button>
									</DialogClose>
									<DialogClose asChild>
										<Button>Confirm</Button>
									</DialogClose>
								</DialogFooter>
							</DialogContent>
						</Dialog>
					</Row>
				</Section>

				<Section title="DropdownMenu">
					<Row label="trigger">
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<Button variant="secondary">Open menu</Button>
							</DropdownMenuTrigger>
							<DropdownMenuContent>
								<DropdownMenuLabel>Actions</DropdownMenuLabel>
								<DropdownMenuItem onSelect={() => toast.info("Item clicked")}>
									Plain item
								</DropdownMenuItem>
								<DropdownMenuCheckboxItem
									checked={checked}
									onCheckedChange={(v) => setChecked(Boolean(v))}
								>
									Checkbox item
								</DropdownMenuCheckboxItem>
								<DropdownMenuSeparator />
								<DropdownMenuRadioGroup value={radio} onValueChange={setRadio}>
									<DropdownMenuRadioItem value="one">One</DropdownMenuRadioItem>
									<DropdownMenuRadioItem value="two">Two</DropdownMenuRadioItem>
								</DropdownMenuRadioGroup>
								<DropdownMenuSeparator />
								<DropdownMenuSub>
									<DropdownMenuSubTrigger>Submenu</DropdownMenuSubTrigger>
									<DropdownMenuSubContent>
										<DropdownMenuItem>Sub item A</DropdownMenuItem>
										<DropdownMenuItem>Sub item B</DropdownMenuItem>
									</DropdownMenuSubContent>
								</DropdownMenuSub>
							</DropdownMenuContent>
						</DropdownMenu>
					</Row>
				</Section>

				<Section title="Tooltip">
					<Row label="trigger">
						<Tooltip>
							<TooltipTrigger asChild>
								<Button variant="ghost">Hover me</Button>
							</TooltipTrigger>
							<TooltipContent>This is a tooltip</TooltipContent>
						</Tooltip>
					</Row>
				</Section>

				<Section title="Popover">
					<Row label="trigger">
						<Popover>
							<PopoverTrigger asChild>
								<Button variant="secondary">Open popover</Button>
							</PopoverTrigger>
							<PopoverContent>
								<div className="flex flex-col gap-2">
									<p className="text-sm font-medium">Popover content</p>
									<p className="text-sm text-ink-3">
										Arbitrary content can live here.
									</p>
									<Input placeholder="even an input" />
								</div>
							</PopoverContent>
						</Popover>
					</Row>
				</Section>

				<Section title="Select">
					<Row label="default">
						<div className="w-64">
							<Select value={selectValue} onValueChange={setSelectValue}>
								<SelectTrigger>
									<SelectValue placeholder="Pick an option" />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="alpha">Alpha</SelectItem>
									<SelectItem value="beta">Beta</SelectItem>
									<SelectItem value="gamma">Gamma</SelectItem>
								</SelectContent>
							</Select>
						</div>
					</Row>
					<Row label="disabled">
						<div className="w-64">
							<Select disabled>
								<SelectTrigger>
									<SelectValue placeholder="Disabled" />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="x">X</SelectItem>
								</SelectContent>
							</Select>
						</div>
					</Row>
				</Section>

				<Section title="Tabs">
					<Row label="default">
						<div className="w-full max-w-md">
							<Tabs defaultValue="tab1">
								<TabsList>
									<TabsTrigger value="tab1">Inbox</TabsTrigger>
									<TabsTrigger value="tab2">Sent</TabsTrigger>
									<TabsTrigger value="tab3">Drafts</TabsTrigger>
								</TabsList>
								<TabsContent value="tab1">
									<p className="text-sm text-ink">Inbox content</p>
								</TabsContent>
								<TabsContent value="tab2">
									<p className="text-sm text-ink">Sent content</p>
								</TabsContent>
								<TabsContent value="tab3">
									<p className="text-sm text-ink">Drafts content</p>
								</TabsContent>
							</Tabs>
						</div>
					</Row>
				</Section>

				<Section title="Switch">
					<Row label="unchecked">
						<Switch checked={false} onCheckedChange={() => {}} />
					</Row>
					<Row label="checked">
						<Switch checked={switchOn} onCheckedChange={setSwitchOn} />
					</Row>
					<Row label="disabled">
						<Switch disabled />
						<Switch disabled checked />
					</Row>
				</Section>

				<Section title="Sonner Toaster">
					<Row label="actions">
						<Button onClick={() => toast.success("Saved successfully")}>
							toast.success
						</Button>
						<Button
							variant="destructive"
							onClick={() => toast.error("Something went wrong")}
						>
							toast.error
						</Button>
						<Button
							variant="secondary"
							onClick={() => toast.info("Just so you know…")}
						>
							toast.info
						</Button>
					</Row>
				</Section>

				<Toaster />
			</div>
		</TooltipProvider>
	);
}
