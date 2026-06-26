export const defaultCinderLimit = 500;
export const cinderLimitTargets = [800, 1100, 1600, 2100, 2600, 3000] as const;
export const cinderLimitPrices = [350, 500, 750, 900, 1200, 1500] as const;

export function limitForExistingBalance(balance: number) {
  if (balance <= defaultCinderLimit) return defaultCinderLimit;
  return cinderLimitTargets.find((target) => balance <= target) ?? Math.max(balance, cinderLimitTargets.at(-1)!);
}

export function nextCinderLimitOffer(currentLimit: number) {
  const index = cinderLimitTargets.findIndex((target) => currentLimit < target);
  if (index === -1) return null;
  return {
    price: cinderLimitPrices[index] ?? cinderLimitPrices.at(-1)!,
    target: cinderLimitTargets[index],
    stageLabel: `${currentLimit} -> ${cinderLimitTargets[index]}`,
  };
}

export function freeCinderSpace(balance: number, limit: number) {
  return Math.max(0, limit - balance);
}
