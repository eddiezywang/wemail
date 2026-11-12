import {
  Notification,
  type NotificationConstructorOptions,
} from "electron";

const WEMAIL_APP_USER_MODEL_ID = "com.wemail.app";

interface DesktopNotificationApi {
  isSupported: () => boolean;
  create: (options: DesktopNotificationOptions) => {
    show: () => void;
    on?: (...args: any[]) => unknown;
  };
}

export type DesktopNotificationOptions = Pick<
  NotificationConstructorOptions,
  | "title"
  | "body"
  | "icon"
  | "silent"
  | "timeoutType"
  | "urgency"
  | "toastXml"
> & {
  /**
   * Action buttons rendered by the self-drawn notification overlay. Named
   * `actionButtons` to avoid colliding with Electron's own `actions`
   * (NotificationAction[]); the coordinator also embeds the same actions in
   * `toastXml` for the native toast path.
   */
  actionButtons?: Array<{ label: string; arguments: string }>;
  /** Short glyph for the self-drawn overlay's sender avatar. */
  avatarText?: string;
  /** Left accent bar color for the self-drawn overlay. */
  accent?: "brand" | "amber";
};

export interface DesktopNotificationResult {
  supported: boolean;
  shown: boolean;
}

export interface DesktopNotificationActivationHandlers {
  onClick?: () => void;
  onAction?: (index: number) => void;
}

export function configureDesktopNotifications(
  app: { setAppUserModelId?: (id: string) => void },
  platform = process.platform,
  env = process.env,
  execPath = process.execPath,
) {
  if (platform !== "win32") return undefined;
  const appUserModelId = env.WEMAIL_APP_USER_MODEL_ID ?? WEMAIL_APP_USER_MODEL_ID;
  app.setAppUserModelId?.(appUserModelId);
  return appUserModelId;
}

export function showDesktopNotificationWith(
  notificationApi: DesktopNotificationApi,
  options: DesktopNotificationOptions,
  handlers?: DesktopNotificationActivationHandlers,
): DesktopNotificationResult;
export function showDesktopNotificationWith(
  notificationApi: DesktopNotificationApi,
  title: string,
  body: string,
  icon?: string,
): DesktopNotificationResult;
export function showDesktopNotificationWith(
  notificationApi: DesktopNotificationApi,
  optionsOrTitle: DesktopNotificationOptions | string,
  bodyOrHandlers?: string | DesktopNotificationActivationHandlers,
  icon?: string,
): DesktopNotificationResult {
  if (!notificationApi.isSupported()) {
    return { supported: false, shown: false };
  }
  const options =
    typeof optionsOrTitle === "string"
      ? {
          title: optionsOrTitle,
          body:
            typeof bodyOrHandlers === "string"
              ? bodyOrHandlers
              : undefined,
          ...(icon ? { icon } : {}),
        }
      : optionsOrTitle;
  const handlers =
    typeof optionsOrTitle === "string" || typeof bodyOrHandlers === "string"
      ? undefined
      : bodyOrHandlers;
  const notification = notificationApi.create(options);
  if (handlers?.onClick) {
    notification.on?.("click", handlers.onClick);
  }
  if (handlers?.onAction) {
    notification.on?.(
      "action",
      (details: { actionIndex?: number }, legacyActionIndex?: number) =>
        handlers.onAction?.(
          typeof details?.actionIndex === "number"
            ? details.actionIndex
            : legacyActionIndex ?? -1,
        ),
    );
  }
  notification.show();
  return { supported: true, shown: true };
}

export function showDesktopNotification(
  options: DesktopNotificationOptions,
  handlers?: DesktopNotificationActivationHandlers,
): DesktopNotificationResult;
export function showDesktopNotification(
  title: string,
  body: string,
  icon?: string,
): DesktopNotificationResult;
export function showDesktopNotification(
  optionsOrTitle: DesktopNotificationOptions | string,
  bodyOrHandlers?: string | DesktopNotificationActivationHandlers,
  icon?: string,
): DesktopNotificationResult {
  const notificationApi = {
    isSupported: () => Notification.isSupported(),
    create: (options: DesktopNotificationOptions) =>
      new Notification(options),
  };
  return typeof optionsOrTitle === "string"
    ? showDesktopNotificationWith(
        notificationApi,
        optionsOrTitle,
        typeof bodyOrHandlers === "string" ? bodyOrHandlers : "",
        icon,
      )
    : showDesktopNotificationWith(
        notificationApi,
        optionsOrTitle,
        typeof bodyOrHandlers === "string" ? undefined : bodyOrHandlers,
      );
}

export interface WindowsToastXmlInput {
  title: string;
  lines: string[];
  icon?: string;
  launch: string;
  actions?: Array<{
    label: string;
    arguments: string;
  }>;
  silent: boolean;
}

export function buildWindowsToastXml(input: WindowsToastXmlInput): string {
  const text = [
    `<text>${escapeXml(input.title)}</text>`,
    ...input.lines.map((line) => `<text>${escapeXml(line)}</text>`),
    `<text placement="attribution">WeMail</text>`,
  ].join("");
  const image = input.icon
    ? `<image placement="appLogoOverride" src="${escapeXml(toFileUrl(input.icon))}"/>`
    : "";
  const actions = input.actions?.length
    ? `<actions>${input.actions
        .map(
          (action) =>
            `<action content="${escapeXml(action.label)}" arguments="${escapeXml(action.arguments)}" activationType="foreground"/>`,
        )
        .join("")}</actions>`
    : "";
  const audio = input.silent ? `<audio silent="true"/>` : "";

  return `<toast launch="${escapeXml(input.launch)}"><visual><binding template="ToastGeneric">${image}${text}</binding></visual>${actions}${audio}</toast>`;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;");
}

function toFileUrl(filePath: string): string {
  if (/^file:\/\//i.test(filePath)) return filePath;
  return `file:///${filePath.replaceAll("\\", "/")}`;
}
