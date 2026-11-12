// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { WarningIcon } from "@phosphor-icons/react/Warning";
import { useNavigate } from "react-router";
import { Button } from "~/components/ui/button";
import { zhCN } from "~/copy/zh-CN";

export default function NotFoundRoute() {
	const navigate = useNavigate();

	return (
		<div className="flex h-full min-h-0 items-center justify-center bg-paper-2">
			{/* TODO(kumo): replaced Kumo <Empty> with inline composition; promote to a shared component if reused */}
			<div className="flex flex-col items-center text-center max-w-md px-6">
				<div className="mb-4">
					<WarningIcon size={48} className="text-ink-4" />
				</div>
				<h2 className="text-base font-semibold text-ink mb-1.5">
					{zhCN.notFound.title}
				</h2>
				<p className="text-sm text-ink-3 max-w-sm mb-5">
					{zhCN.notFound.description}
				</p>
				<Button size="sm" onClick={() => navigate("/")}>
					{zhCN.notFound.backHome}
				</Button>
			</div>
		</div>
	);
}
