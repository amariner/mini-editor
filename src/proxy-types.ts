export interface ProxyConfig {
  mode: 'system' | 'manual';
  protocol: 'http' | 'https';
  host: string;
  port: number;
  username: string;
  caFile: string;
}
export interface ProxyUpdate extends ProxyConfig {
  password?: string;
  clearPassword?: boolean;
}
export interface ProxySnapshot extends ProxyConfig {
  hasPassword: boolean;
  secureStorage: boolean;
  error?: string;
}
export const defaultProxy: ProxyConfig = {
  mode: 'system',
  protocol: 'http',
  host: '',
  port: 8080,
  username: '',
  caFile: '',
};
