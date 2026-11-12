export function langBotApiSecretKey(connectionId: string): string {
  return `wemail:langbot:${encodeURIComponent(connectionId)}:api-key`;
}

export function langBotWebhookSecretKey(connectionId: string): string {
  return `wemail:langbot:${encodeURIComponent(connectionId)}:webhook-secret`;
}

export function botPlatformSecretKey(
  platform: "feishu" | "wecom",
  profileId: string,
): string {
  return `wemail:bot:${platform}:${encodeURIComponent(profileId)}:secret`;
}
