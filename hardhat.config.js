require("@nomicfoundation/hardhat-toolbox");

// Network-aware env loading: when targeting mainnet (--network mainnet or
// HARDHAT_NETWORK=mainnet) load .env.mainnet so MAINNET_RPC_URL / ETHERSCAN_API_KEY /
// mainnet KMS aliases resolve. Otherwise default to .env.sepolia, then .env.
const fs = require('fs');
const targetNetwork =
  process.env.HARDHAT_NETWORK ||
  (process.argv.join(' ').match(/--network\s+([^\s]+)/) || [])[1];
let envPath;
if (targetNetwork === 'mainnet' && fs.existsSync('.env.mainnet')) {
  envPath = '.env.mainnet';
} else if (fs.existsSync('.env.sepolia')) {
  envPath = '.env.sepolia';
}
require("dotenv").config(envPath ? { path: envPath } : {});

// Opt-in mainnet fork for the in-process `hardhat` network (FORK_MAINNET=1).
// Forking must be configured at init — EDR cannot hardhat_reset onto a fork at
// runtime (it can't overlay the local genesis accounts). Pull the fork RPC from
// .env.mainnet even though we run on the `hardhat` network, not `mainnet`.
let mainnetForking;
if (process.env.FORK_MAINNET === '1') {
  if (fs.existsSync('.env.mainnet')) {
    require("dotenv").config({ path: '.env.mainnet' });
  }
  const forkUrl = process.env.MAINNET_RPC_URL;
  if (!forkUrl) {
    throw new Error("FORK_MAINNET=1 but MAINNET_RPC_URL is not set (expected in .env.mainnet).");
  }
  mainnetForking = {
    url: forkUrl,
    ...(process.env.FORK_BLOCK ? { blockNumber: Number(process.env.FORK_BLOCK) } : {}),
  };
}

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.20",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200
      },
      viaIR: true
    }
  },
  networks: {
    hardhat: {
      // When forking mainnet, present as chainId 1 so deployed contracts behave
      // as on mainnet; otherwise the normal local chain id.
      chainId: mainnetForking ? 1 : 31337,
      allowUnlimitedContractSize: true,
      ...(mainnetForking ? { forking: mainnetForking } : {})
    },
    localhost: {
      url: "http://127.0.0.1:8545",
      chainId: 31337
    },
    mainnet: {
      url: process.env.MAINNET_RPC_URL || "",
      accounts: [],
      chainId: 1
    },
    sepolia: {
      url: process.env.SEPOLIA_RPC_URL || process.env.RPC_URL || "https://eth-sepolia.g.alchemy.com/v2/your-api-key",
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
      chainId: 11155111
    }
  },
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY
  },
  sourcify: {
    enabled: false
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts"
  },
  mocha: {
    timeout: 40000
  }
};
