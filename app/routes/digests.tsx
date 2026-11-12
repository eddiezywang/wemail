// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { SummaryCenterPage } from "~/components/digests/SummaryCenterPage";

export function meta() {
	return [{ title: "智能中心 / Intelligence Center" }];
}

export default function DigestsRoute() {
	return <SummaryCenterPage />;
}
