# Sepolia Deployment Status

**Date:** May 23, 2026
**Status:** Infrastructure and launch pools deployed

## Current Sepolia Deployment

The current Sepolia deployment is recorded in `deployments/sepolia-latest.json`.

### Infrastructure

- **ModelRegistry:** `0x2d6C3db727fa9ef601d16495651Bb28Cf5240C76`
- **TokenDeploymentFactory:** `0xc24b99D64c95EDbAac8B22278D032Abd63Cd7bac`
- **TokenManager:** `0x6a1952519396f14f9E02775c17dB0ce5E2616968`
- **RewardVestingVault:** `0x985bFb01C3de950D4eB4B88c00978529e1b9B595`
- **DataContributionRegistry:** `0xf3031aAb3D23efC92AD7Ded2D02A7d0f0b979AEA`
- **MockUSDC:** `0xc3Da8fb0Fb0014137FcBcbe80B093c51243c51Ad`
- **HokusaiAMMFactory:** `0xd62258981f609C3fA6AF9C8Bcb56569d8a4b88F6`
- **HokusaiAMMPoolDeployer:** `0xF287985596F36797fdA82e7C6CA77801A96189a2`
- **InfrastructureReserve:** `0x1Bcc924867E8CFfB29eECd27CffcF0D3F23F53F6`
- **InfrastructureCostOracle:** `0x715d2881FB8dbfC0b5d92A1e931dA3766544CC7c`
- **UsageFeeRouter:** `0xCDa3604f9D7F89e47eE1ebc1d27A13fa7551C04d`
- **DeltaVerifier:** `0x799096D8d7C153dDA2d9B3F68793a91ca256ae66`

### Launch Pools

1. **Hokusai Messaging** (`HMESS`)
   - Config slug: `hmess`
   - Model ID: `28`
   - Token: `0xa767A759797dE7df37AF66df8E48E488C0e20d53`
   - Params: `0xd6A07ad53eb785bF667a96a29a57b4AA3ea3a39d`
   - AMM: `0x0660Bc7f61248EeA9a36cDEb370C8C0FB8338518`

2. **Hokusai Sales Lead Scoring** (`HLEAD`)
   - Config slug: `hlead`
   - Model ID: `27`
   - Token: `0xcd575e6db1efa570D338194afF5BdD580250cB9B`
   - Params: `0x1fCb58a74a7fcb1F377b74372ac10e732b1e254f`
   - AMM: `0xa633d97B14DC74a9d23845db13B5EbBB9a4aD824`

3. **Hokusai Task Routing** (`HROUT`)
   - Config slug: `hrout`
   - Model ID: `30`
   - Token: `0x47eBd73FCF7cABA6DB5cBAFAb4C2ca85d9252810`
   - Params: `0xA9B4a260f06e674c7a24AECaE0D195E01cc8D422`
   - AMM: `0xdC4132c09DA135A9aaC28B6Da7c879D117C9dEFF`

## Verification

`npm run smoke:sepolia` passed against `deployments/sepolia-latest.json` with 86 checks passing, 0 warnings, and 0 failures.
