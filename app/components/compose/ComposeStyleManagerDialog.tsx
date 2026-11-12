import { useNavigate, useSearchParams } from "react-router";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
} from "~/components/ui/dialog";
import { WritingStyleSection } from "~/components/settings/sections/WritingStyleSection";

export function ComposeStyleManagerDialog() {
	const [searchParams] = useSearchParams();
	const navigate = useNavigate();
	const open = searchParams.get("compose") === "styles";

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!next) navigate("/", { replace: true });
			}}
		>
			<DialogContent className="max-h-[78vh] max-w-[720px] overflow-y-auto">
				<DialogTitle>管理写作风格</DialogTitle>
				<DialogDescription>
					创建的风格会立即出现在撰写窗口的“写作风格”选择器中。
				</DialogDescription>
				<WritingStyleSection />
			</DialogContent>
		</Dialog>
	);
}
