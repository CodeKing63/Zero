const UNLIMITED_FEATURE = {
  total: 0,
  remaining: 0,
  unlimited: true,
  enabled: true,
  usage: 0,
  nextResetAt: null,
  interval: '',
  included_usage: 0,
};

const noop = async () => {};

export const useBilling = () => ({
  isLoading: false,
  customer: null,
  refetch: noop,
  attach: noop,
  track: noop,
  openBillingPortal: noop,
  isPro: true,
  chatMessages: UNLIMITED_FEATURE,
  connections: UNLIMITED_FEATURE,
  brainActivity: UNLIMITED_FEATURE,
});
