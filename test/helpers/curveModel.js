// Floating-point reference model of HokusaiAMM's post-graduation pricing
// (HOK-3317). The reserve R backs the redeemable supply S along
//   f(s) = s                                   for s <= S_g
//   f(s) = S_g × ((1 - w) + w × (s/S_g)^(1/w))  for s >  S_g
// scaled by k = R / f(S). Above S_g this is the Bancor curve on the "curve
// reserve" R - (1 - w) × k × S_g. Results are floats: compare with a relative
// tolerance (see near()).

function curveModel(crrPpm) {
  const w = Number(crrPpm) / 1e6;
  const f = (s, sg) => (s <= sg ? s : sg * (1 - w + w * Math.pow(s / sg, 1 / w)));
  const fInv = (y, sg) => (y <= sg ? y : sg * Math.pow((y / sg - (1 - w)) / w, w));
  const slope = (s, sg) => (s <= sg ? 1 : Math.pow(s / sg, 1 / w - 1));

  return {
    w,
    f,
    fInv,
    slope,
    // Tokens (wei) for `net` reserve units after the trade fee.
    buyTokens: (R, S, sg, net) => fInv((f(S, sg) * (R + net)) / R, sg) - S,
    // Reserve units released by selling T token wei.
    sellReserve: (R, S, sg, T) => (R * (f(S, sg) - f(S - T, sg))) / f(S, sg),
    // Spot price in reserve units per whole token.
    spot: (R, S, sg) => (R * slope(S, sg) * 1e18) / f(S, sg),
    // Reserve above the (1 - w) × k × S_g floor: the Bancor reserve, which
    // satisfies curveReserve = w × spot × S above the anchor.
    curveReserve: (R, S, sg) => (R * (f(S, sg) - (1 - w) * Math.min(S, sg))) / f(S, sg),
  };
}

// The anchor in force: the recorded anchor rescaled by supply changes outside
// the pool since it was recorded (the current supply if none is recorded).
function effectiveAnchor(anchor, basis, supply) {
  if (anchor === 0n || basis === 0n) return supply;
  return basis === supply ? anchor : (anchor * supply) / basis;
}

// Reads the model inputs from a pool: reserve, redeemable supply, anchor.
async function poolCurveState(amm, tokenManager, modelId) {
  const reserve = await amm.reserveBalance();
  const supply = await tokenManager.getRedeemableSupply(modelId);
  const anchor = effectiveAnchor(await amm.graduationSupply(), await amm.anchorBasisSupply(), supply);
  return { R: Number(reserve), S: Number(supply), sg: Number(anchor) };
}

// closeTo arguments for a float expectation with relative tolerance `rel`.
function near(expected, rel = 1e-9) {
  return [BigInt(Math.round(expected)), BigInt(Math.floor(Math.max(Math.abs(expected) * rel, 2)))];
}

module.exports = { curveModel, poolCurveState, effectiveAnchor, near };
