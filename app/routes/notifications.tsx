import { ApplicationMessageCenter } from "~/components/applicationMessages/ApplicationMessageCenter";
import { useCurrentAccount } from "~/queries/currentAccount";

export function meta() { return [{ title: "应用消息 / WeMail" }]; }

export default function NotificationsRoute() {
	const { data } = useCurrentAccount();
	return <ApplicationMessageCenter accountId={data?.account?.id} />;
}
