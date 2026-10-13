export const CURRENCY = 'usd';
 
export const PLANS = [
  { id: 'pack_1',  credits: 1,  priceCents: 100  },
  { id: 'pack_5',  credits: 5,  priceCents: 500  },
  { id: 'pack_10', credits: 10, priceCents: 1000 },
];
 
export const getPlan = (id) => PLANS.find((p) => p.id === id) || null;