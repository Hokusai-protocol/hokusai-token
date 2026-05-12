const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--config") {
      args.config = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

function requireArg(value, name) {
  if (!value) {
    throw new Error(`Missing required argument: ${name}`);
  }
  return value;
}

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

async function grantRoleIfMissing(contract, role, account) {
  if (!(await contract.hasRole(role, account))) {
    const tx = await contract.grantRole(role, account);
    await tx.wait();
  }
}

async function main() {
  const { ethers } = hre;
  const [deployer] = await ethers.getSigners();
  const args = parseArgs(process.argv.slice(2));
  const configPath = requireArg(args.config, "--config");
  const absoluteConfigPath = path.resolve(configPath);
  const config = loadJson(absoluteConfigPath);
  const networkName = hre.network.name;
  const deploymentPath = path.join(__dirname, "..", "deployments", `${networkName}-latest.json`);

  if (!fs.existsSync(deploymentPath)) {
    throw new Error(`Missing deployment artifact: ${deploymentPath}`);
  }

  const deployment = loadJson(deploymentPath);
  const contracts = deployment.contracts || {};

  const modelRegistry = await ethers.getContractAt("ModelRegistry", contracts.ModelRegistry);
  const tokenManager = await ethers.getContractAt("TokenManager", contracts.TokenManager);
  const deltaVerifier = await ethers.getContractAt("DeltaVerifier", contracts.DeltaVerifier);
  const contributionRegistry = await ethers.getContractAt("DataContributionRegistry", contracts.DataContributionRegistry);

  const submitterAddress = config.submitterAddress || process.env.SUBMITTER_ADDRESS || deployer.address;
  const governor = config.governor || deployer.address;
  const initialSupply = ethers.parseEther(config.initialSupply);
  const tokensPerDeltaOne = ethers.parseEther(config.tokensPerDeltaOne);
  const vestingConfig = config.vestingConfig || {
    enabled: false,
    immediateUnlockBps: 10000,
    vestingDurationSeconds: 0,
    cliffSeconds: 0,
  };

  const deployTx = await tokenManager.deployTokenWithParams(
    String(config.modelId),
    config.tokenName,
    config.tokenSymbol,
    initialSupply,
    {
      tokensPerDeltaOne,
      infrastructureAccrualBps: config.infrastructureAccrualBps,
      initialOraclePricePerThousandUsd: config.initialOraclePricePerThousandUsd || 0,
      licenseHash: config.licenseHash || ethers.ZeroHash,
      licenseURI: config.licenseURI || "",
      governor,
      vestingConfig,
    }
  );
  const deployReceipt = await deployTx.wait();

  let tokenAddress;
  let paramsAddress;
  for (const log of deployReceipt.logs) {
    try {
      const parsed = tokenManager.interface.parseLog(log);
      if (parsed?.name === "TokenDeployed") {
        tokenAddress = parsed.args.tokenAddress;
      }
      if (parsed?.name === "ParamsDeployed") {
        paramsAddress = parsed.args.paramsAddress;
      }
    } catch {
      // Ignore unrelated logs.
    }
  }

  if (!tokenAddress || !paramsAddress) {
    throw new Error("Failed to resolve deployed token or params address");
  }

  if (!(await modelRegistry.isRegistered(config.modelId))) {
    const registerTx = await modelRegistry.registerModel(config.modelId, tokenAddress, config.metricName);
    await registerTx.wait();
  }

  await tokenManager.setDeltaVerifier(await deltaVerifier.getAddress());
  await grantRoleIfMissing(tokenManager, await tokenManager.MINTER_ROLE(), await deltaVerifier.getAddress());
  await grantRoleIfMissing(deltaVerifier, await deltaVerifier.SUBMITTER_ROLE(), submitterAddress);
  await grantRoleIfMissing(contributionRegistry, await contributionRegistry.RECORDER_ROLE(), await deltaVerifier.getAddress());

  const params = await ethers.getContractAt("HokusaiParams", paramsAddress);
  const metricType = await params.metricType();
  if (metricType !== 0n) {
    throw new Error(`Expected MetricType.SingleMetric (0), got ${metricType.toString()}`);
  }

  const outputPath = path.join(__dirname, "..", "deployments", `${networkName}-${config.modelId}.json`);
  const artifact = {
    timestamp: new Date().toISOString(),
    network: networkName,
    modelId: config.modelId,
    metricName: config.metricName,
    tokenAddress,
    paramsAddress,
    deltaVerifierAddress: await deltaVerifier.getAddress(),
    submitterAddress,
    tokensPerDeltaOne: tokensPerDeltaOne.toString(),
    deploymentTxHash: deployReceipt.hash,
  };

  fs.writeFileSync(outputPath, JSON.stringify(artifact, null, 2));
  console.log(JSON.stringify(artifact, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
