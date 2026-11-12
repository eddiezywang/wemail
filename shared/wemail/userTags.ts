export interface UserTag {
  id: string;
  accountId: string;
  name: string;
  description: string;
  prompt: string;
  optimizedPrompt?: string;
  optimizedPromptVersion?: string;
  optimizedFromPromptHash?: string;
  optimizedAt?: string;
  effectivePrompt: string;
  creationSource: "manual" | "topic-suggestion";
  sourceTopicId?: string;
  createdAt: string;
  updatedAt: string;
}
