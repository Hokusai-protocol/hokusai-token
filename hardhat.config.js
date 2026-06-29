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
      chainId: 31337,
      allowUnlimitedContractSize: true
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
