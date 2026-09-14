import type { Env } from '@burtplace/config';
import type { BiometricProvider } from './provider.js';
import { WebhookBiometricProvider } from './webhook-adapter.js';
import { VyomBiometricProvider } from './vyom-adapter.js';

export function createBiometricProvider(env: Env): BiometricProvider | null {
  switch (env.BIOMETRIC_PROVIDER) {
    case 'webhook': return new WebhookBiometricProvider();
    case 'vyom': return new VyomBiometricProvider({ baseUrl: env.VYOM_BASE_URL, username: env.VYOM_USERNAME, password: env.VYOM_PASSWORD });
    case 'none': return null;
  }
}
export const webhookProvider = new WebhookBiometricProvider();
