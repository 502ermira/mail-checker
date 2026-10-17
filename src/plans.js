export const CURRENCY = 'usd';

export const PLANS = [
  { id: 'pack_3', priceCents: 300, credits: 3, bonusCredits: 2 }, // 5 total
  { id: 'pack_5', priceCents: 500, credits: 5, bonusCredits: 3 }, // 8 total
  { id: 'pack_7', priceCents: 700, credits: 7, bonusCredits: 5 }, // 12 total
  { id: 'pack_20', priceCents: 2000, credits: 20, bonusCredits: 5 }, // 25 total
];

export const CUSTOM = {
  id: 'custom',
  minDollars: 1,
  maxDollars: 500,
  creditsPerDollar: 1,
};

export function resolvePurchase(planId, amount) {
  if (planId === CUSTOM.id) {
    const dollars = Number(amount);
    if (!Number.isInteger(dollars) || dollars < CUSTOM.minDollars || dollars > CUSTOM.maxDollars)
      return { error: `Enter a whole amount from ${CUSTOM.minDollars} to ${CUSTOM.maxDollars}.` };
    return {
      planId: CUSTOM.id,
      priceCents: dollars * 100,
      bonusCredits: 0,
      totalCredits: dollars * CUSTOM.creditsPerDollar,
    };
  }
  const plan = PLANS.find((p) => p.id === planId);
  if (!plan) return { error: 'Unknown plan.' };
  return {
    planId: plan.id,
    priceCents: plan.priceCents,
    bonusCredits: plan.bonusCredits,
    totalCredits: plan.credits + plan.bonusCredits,
  };
}