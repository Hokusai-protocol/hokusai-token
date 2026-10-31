export function normalizePhase(value: unknown): 0 | 1 {
  if (value === 0 || value === 0n) {
    return 0;
  }
  if (value === 1 || value === 1n) {
    return 1;
  }
  throw new Error(`Invalid pricing phase: ${String(value)}`);
}

/** R/(P*S), with R and P both in micro-USDC and S in token wei. */
export function reserveRatio(reserve: bigint, price: bigint, supply: bigint): number {
  if (price <= 0n || supply <= 0n) {
    return 0;
  }
  return Number((reserve * 10n ** 18n * 10n ** 12n) / (price * supply)) / 1e12;
}

/** Derived from released HokusaiAMM._curvePoint/_anchorSupply, not Bancor R/(P*S)=w. */
export function anchoredReserveRatio(
  supply: bigint,
  anchor: bigint,
  basis: bigint,
  crr: number,
): number {
  if (crr <= 0 || crr > 1_000_000) {
    throw new Error('Invalid CRR');
  }
  const effectiveAnchor = anchor === 0n || basis === 0n ? supply : (anchor * supply) / basis;
  if (supply <= effectiveAnchor) {
    return 1;
  }
  const w = crr / 1_000_000;
  const x = Number(supply) / Number(effectiveAnchor);
  return w + (1 - w) * Math.pow(x, -1 / w);
}
