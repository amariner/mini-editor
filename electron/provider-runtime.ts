import type { PreparedAttachment } from './attachments';
export interface ProviderRuntime {
  send(text: string, attachments: PreparedAttachment[], promptText?: string): Promise<void>;
  stop(): Promise<void>;
  interrupt(): Promise<void>;
  approve(id: string | number, decision: 'accept' | 'always' | 'decline'): void;
}
