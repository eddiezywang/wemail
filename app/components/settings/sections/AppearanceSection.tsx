// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Tabs, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { useTheme, type Theme } from "~/hooks/useTheme";

export function AppearanceSection() {
	const { theme, setTheme } = useTheme();
	return (
		<div className="space-y-4">
			<div>
				<h2 className="text-base font-semibold text-ink mb-1">外观</h2>
				<p className="text-xs text-ink-3">
					选择 WeMail 的显示方式。邮件正文始终保持独立的可读表面。
				</p>
			</div>
			<Tabs value={theme} onValueChange={(value) => setTheme(value as Theme)}>
				<TabsList data-testid="theme-selector">
					<TabsTrigger value="system">跟随系统</TabsTrigger>
					<TabsTrigger value="paper">暖石</TabsTrigger>
					<TabsTrigger value="codex">水墨</TabsTrigger>
					<TabsTrigger value="dark">深色</TabsTrigger>
				</TabsList>
			</Tabs>
		</div>
	);
}
