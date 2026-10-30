export interface BrowserDialog {
  id: string;
  type: 'alert' | 'confirm' | 'prompt' | 'beforeunload';
  message: string;
  url: string;
  defaultPrompt?: string;
}
