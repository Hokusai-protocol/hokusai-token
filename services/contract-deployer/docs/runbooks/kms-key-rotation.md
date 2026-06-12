# KMS key rotation runbook

This runbook covers the contract-deployer backend signer and deploy-time signer KMS keys.

## Standard rotation

1. Create the replacement AWS KMS secp256k1 signing key.
2. Attach the normal alias only after the replacement address is known and reviewed.
3. Grant IAM permissions to the relevant principal:
   - Backend key: ECS task role for `kms:GetPublicKey` and `kms:Sign`.
   - Deployer key: human deploy role for `kms:GetPublicKey` and `kms:Sign`.
4. Grant the replacement address the required on-chain roles:
   - Backend key: `SUBMITTER_ROLE` on `DeltaVerifier`.
   - Backend key: fee submitter role on `UsageFeeRouter` when enabled.
   - Deployer key: only the deploy/ops authority required for that network.
5. Drain runtime queues before backend-key rotation:
   - Confirm `MINT_REQUEST_QUEUE` depth is zero.
   - Confirm `MINT_REQUEST_PROCESSING_QUEUE` is empty.
   - Confirm no in-flight settlement jobs are running.
6. Update runtime configuration:
   - Repoint the KMS alias to the replacement key.
   - Update `KMS_BACKEND_EXPECTED_ADDRESS` or `KMS_DEPLOYER_EXPECTED_ADDRESS`.
   - Keep `DEPLOYER_PRIVATE_KEY` unset in production.
7. Restart the service or deployment shell and verify startup succeeds.
8. Verify signer readiness:
   - Health endpoint reports the expected signer address.
   - Backend address has ETH for gas.
   - Backend address has `SUBMITTER_ROLE`.
9. Revoke on-chain roles from the old address after the new signer has completed a clean Sepolia or production transaction.
10. Schedule deletion for the old KMS key using the minimum approved waiting period.

## Alias repoint failure drill

The service pins the derived KMS public-key address to `KMS_*_EXPECTED_ADDRESS`. A stale expected address must fail startup with `KmsSignerAddressMismatch`.

Staging drill:

1. Create a temporary KMS signing key.
2. Repoint the staging alias to the temporary key without changing `KMS_BACKEND_EXPECTED_ADDRESS`.
3. Restart one staging task.
4. Confirm the task exits during startup with `KmsSignerAddressMismatch`.
5. Restore the alias to the approved key.
6. Restart the task and confirm readiness returns to healthy.

If the task does not fail during step 4, stop rotation and investigate before any production alias change.

## Integration check

Before Gate 7, run the gated Sepolia tests with AWS credentials present:

```bash
KMS_BACKEND_KEY_ID=alias/hokusai/development/ethereum/sepolia/submitter \
KMS_BACKEND_EXPECTED_ADDRESS=0xbe2640bB22ae79f0d611aC727036fEBcFB7acf0c \
npm test -- --runInBand tests/integration/kms-signer-sepolia.test.ts
```

The required manual acceptance is one successful Sepolia mint cycle and one successful fee deposit through the backend KMS signer.
