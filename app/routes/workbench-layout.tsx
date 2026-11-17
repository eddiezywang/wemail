import { Outlet } from "react-router";
import { MessageDetailView, WorkbenchShell } from "./_workbench";

/**
 * Persistent authenticated application shell. Child route changes only replace
 * the primary workspace outlet; navigation, detail, Agent, and global overlays
 * keep their component identity across product navigation.
 */
export default function WorkbenchLayoutRoute() {
	return (
		<WorkbenchShell
			list={<Outlet />}
			detail={<MessageDetailView />}
		/>
	);
}
