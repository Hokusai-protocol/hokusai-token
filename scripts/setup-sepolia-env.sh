#!/bin/bash

# Script to set up environment for Sepolia deployment

echo "Setting up Sepolia environment variables..."

# Check if .env.sepolia exists
if [ -f .env.sepolia ]; then
    echo "Loading variables from .env.sepolia..."

    # Export variables from .env.sepolia
    export $(cat .env.sepolia | grep -v '^#' | xargs)

    # Map RPC_URL to SEPOLIA_RPC_URL if needed
    if [ -n "$RPC_URL" ] && [ -z "$SEPOLIA_RPC_URL" ]; then
        export SEPOLIA_RPC_URL=$RPC_URL
        echo "✓ Set SEPOLIA_RPC_URL from RPC_URL"
    fi

    # Check if required variables are set
    if [ -z "$SEPOLIA_RPC_URL" ]; then
        echo "❌ Error: SEPOLIA_RPC_URL or RPC_URL not set in .env.sepolia"
        echo "Please add your Alchemy/Infura API key to .env.sepolia"
        exit 1
    fi

    if [ -z "$DEPLOYER_PRIVATE_KEY" ]; then
        echo "❌ Error: DEPLOYER_PRIVATE_KEY not set in .env.sepolia"
        echo "Please add your deployer private key to .env.sepolia"
        exit 1
    fi

    echo "✓ Environment variables loaded successfully"
    echo ""
    echo "Now run:"
    echo "npx hardhat run scripts/deploy-token-with-params.js --network sepolia"

else
    echo "❌ Error: .env.sepolia file not found"
    echo ""
    echo "Please create .env.sepolia with the following content:"
    echo "----------------------------------------"
    echo "# Get your API key from https://www.alchemy.com/ or https://infura.io/"
    echo "RPC_URL=https://eth-sepolia.g.alchemy.com/v2/YOUR_API_KEY_HERE"
    echo ""
    echo "# Your wallet private key (with 0x prefix)"
    echo "# Make sure it has Sepolia ETH for gas!"
    echo "DEPLOYER_PRIVATE_KEY=0x..."
    echo "----------------------------------------"
    exit 1
fi