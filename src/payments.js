const provider = () => process.env.PAYMENT_PROVIDER || 'test';

export function isTestMode() {
  return provider() === 'test';
}

export function isCrypto() {
  return provider() === 'tron';
}

export function paymentsAvailable() {
  if (isTestMode()) return process.env.NODE_ENV !== 'production' || process.env.ALLOW_TEST_PAYMENTS === '1';
  if (isCrypto()) return Boolean(process.env.TRON_ADDRESS);
  return false;
}

export async function createCheckout(order) {
  if (isTestMode()) return { paid: true, providerRef: `test_${order.id}` };
  throw new Error(`unknown_payment_provider_${provider()}`);
}