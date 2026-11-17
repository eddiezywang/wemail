import { XIcon } from "@phosphor-icons/react/X";
import type { ApplicationMessage } from "../../../shared/wemail/applicationMessages";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "~/components/ui/dialog";
import { IconAction } from "~/components/ui/icon-action";
import api from "~/services/api";

export function ArtifactViewer({
	accountId,
	message,
	onClose,
}: {
	accountId: string;
	message: Pick<ApplicationMessage, "id" | "title" | "artifact">;
	onClose: () => void;
	viewport?: boolean;
}) {
	const source = api.getApplicationMessageArtifactUrl(message.id, accountId);
	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent showClose={false} className="!inset-0 !left-0 !top-0 !h-[100dvh] !w-screen !max-w-none !translate-x-0 !translate-y-0 !gap-0 !overflow-hidden !rounded-none !border-0 !bg-white !p-0 !shadow-none">
				<DialogTitle className="sr-only">{message.title}</DialogTitle>
				<DialogDescription className="sr-only">HTML 洞察报告</DialogDescription>
				<iframe title={message.title} src={source} sandbox="allow-scripts allow-downloads" referrerPolicy="no-referrer" className="h-full w-full border-0 bg-white" />
				<IconAction label="关闭应用内页面" onClick={onClose} className="absolute right-4 top-4 z-10 border border-edge/70 bg-paper/90 shadow-sm backdrop-blur hover:bg-paper"><XIcon size={20} /></IconAction>
			</DialogContent>
		</Dialog>
	);
}
