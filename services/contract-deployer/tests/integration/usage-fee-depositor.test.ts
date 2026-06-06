import { ethers } from 'ethers';
import * as path from 'path';
import * as fs from 'fs';

const SEPOLIA_RPC_URL = process.env.SEPOLIA_RPC_URL;
const DEPLOYER_KEY = process.env.DEPLOYER_PRIVATE_KEY;

const describeIfSepolia = SEPOLIA_RPC_URL && DEPLOYER_KEY ? describe : describe.skip;

describeIfSepolia('UsageFeeRouter - Sepolia Integration', () => {
  let provider: ethers.JsonRpcProvider;
  let signer: ethers.Wallet;
  let usageFeeRouter: ethers.Contract;
  let deploymentConfig: any;

  beforeAll(() => {
    const deploymentPath = path.resolve(__dirname, '../../../../deployments/sepolia-v2-latest.json');
    deploymentConfig = JSON.parse(fs.readFileSync(deploymentPath, 'utf-8'));

    const routerAddress = deploymentConfig.contracts.UsageFeeRouter;
    if (!routerAddress) {
      throw new Error('UsageFeeRouter address not found in sepolia-v2-latest.json');
    }

    const abiPath = path.resolve(__dirname, '../../contracts/UsageFeeRouter.json');
    const { abi } = JSON.parse(fs.readFileSync(abiPath, 'utf-8'));

    provider = new ethers.JsonRpcProvider(SEPOLIA_RPC_URL);
    signer = new ethers.Wallet(DEPLOYER_KEY!, provider);
    usageFeeRouter = new ethers.Contract(routerAddress, abi, signer);
  });

  test('depositFee for an active model emits FeeDeposited', async () => {
    const activeToken = deploymentConfig.tokens?.[0];
    if (!activeToken) {
      console.log('No active tokens in deployment config — skipping');
      return;
    }

    const modelId = activeToken.configKey;
    const reserveTokenAddress = await (usageFeeRouter as any).reserveToken();
    const reserveToken = new ethers.Contract(
      reserveTokenAddress,
      ['function approve(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)'],
      signer
    );

    const depositAmount = ethers.parseUnits('1', 6);
    const balance = await (reserveToken as any).balanceOf(await signer.getAddress());
    if (balance < depositAmount) {
      console.log(`Insufficient reserve token balance (${balance}) — skipping`);
      return;
    }

    const approveTx = await (reserveToken as any).approve(await usageFeeRouter.getAddress(), depositAmount);
    await approveTx.wait(1);

    const tx = await (usageFeeRouter as any).depositFee(modelId, depositAmount, 1);
    const receipt = await tx.wait(1);

    expect(receipt.status).toBe(1);

    const feeDepositedEvent = receipt.logs
      .map((log: ethers.Log) => {
        try {
          return usageFeeRouter.interface.parseLog({ topics: [...log.topics], data: log.data });
        } catch {
          return null;
        }
      })
      .find((parsed: ethers.LogDescription | null) => parsed?.name === 'FeeDeposited');

    expect(feeDepositedEvent).toBeTruthy();
    expect(feeDepositedEvent!.args.totalAmount).toBe(depositAmount);
  }, 60_000);

  test('depositFee for unknown model reverts', async () => {
    const depositAmount = ethers.parseUnits('1', 6);

    await expect(
      (usageFeeRouter as any).depositFee('nonexistent_model_xyz', depositAmount, 1)
    ).rejects.toThrow();
  }, 30_000);
});
