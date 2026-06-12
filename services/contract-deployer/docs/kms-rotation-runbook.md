# KMS Rotation Runbook

## Pre-rotation

- Confirm CloudWatch alarms for unexpected `kms:Sign` activity are green.
- Confirm the mint queue and retry queue are drained or intentionally paused.
- Record the current KMS alias, pinned expected address, and on-chain role holder.

## Create the new key

```bash
aws kms create-key \
  --key-usage SIGN_VERIFY \
  --key-spec ECC_SECG_P256K1 \
  --origin AWS_KMS \
  --region us-east-1
```

- Create or update the alias for the new key.
- Grant `kms:GetPublicKey` and `kms:Sign` to the intended principal only.

## Grant the on-chain role

- From the admin Safe, grant `SUBMITTER_ROLE` to the new backend address.
- For deployer rotation, grant the relevant ownership or operator role before cutover.

## Drain the queue

- Pause consumer workers.
- Wait for in-flight mint requests to settle.
- Confirm queue depth is zero before switching aliases or task definitions.

## Swap runtime config

- Update `KMS_BACKEND_KEY_ID` and `KMS_BACKEND_EXPECTED_ADDRESS` together.
- Update `KMS_DEPLOYER_KEY_ID` and `KMS_DEPLOYER_EXPECTED_ADDRESS` together for deploy roles.
- Redeploy the ECS task or restart the relevant process.

## Revoke the old role

- After the new signer is live and healthy, revoke the old on-chain submitter or deployer role.
- Remove IAM access for principals that should no longer use the old key.

## Schedule key deletion

- Schedule deletion of the retired key with the standard waiting period.
- Record the deletion date in the incident or change log.

## Alias-repoint failure drill

- Intentionally point the alias at a different secp256k1 key without changing `*_EXPECTED_ADDRESS`.
- Restart the service.
- Confirm startup fails with an address pin mismatch error and exits non-zero.
- Confirm the failure is visible in logs and triggers the expected alert path.
