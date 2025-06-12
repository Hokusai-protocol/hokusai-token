// scripts/dev-cycle.js
// Run an end-to-end test of the Hokusai smart contracts. Deploy a contract, register a model, mint tokens, burn tokens, and test the registry and token manager.

const { ethers } = require("hardhat");

async function main() {
  const [deployer, contributor, modelUser] = await ethers.getSigners();

  // Deploy ModelRegistry
  const ModelRegistry = await ethers.getContractFactory("ModelRegistry");
  const registry = await ModelRegistry.deploy();
  console.log("ModelRegistry deployed to:", registry.target);

  // Deploy a HokusaiToken
  const Token = await ethers.getContractFactory("HokusaiToken");
  const token = await Token.deploy();
  console.log("HokusaiToken deployed to:", token.target);

  // Deploy TokenManager
  const TokenManager = await ethers.getContractFactory("TokenManager");
  const manager = await TokenManager.deploy(registry.target);
  console.log("TokenManager deployed to:", manager.target);

  // Set controller on token
  await token.setController(manager.target);

  // Register the model
  const modelName = "TestModelV1";
  const metric = "accuracy";
  const dataFormat = "json";
  const tx = await registry.registerModelAutoId(token.target, metric);
  const receipt = await tx.wait();
  const parsedLog = registry.interface.parseLog(receipt.logs[0]);
  const modelId = parsedLog.args.modelId;

  console.log("Model registered with ID:", modelId.toString());
  console.log("✅ ModelRegistered event emitted:", {
    modelId: parsedLog.args.modelId.toString(),
    tokenAddress: parsedLog.args.tokenAddress,
    performanceMetric: parsedLog.args.performanceMetric
  });

  // Validate metadata retrieval
  console.log("\n--- Metadata Retrieval Validation ---");
  
  // Test getModel() returns correct values
  const modelInfo = await registry.getModel(modelId);
  console.log("✅ getModel() returns:", {
    tokenAddress: modelInfo.tokenAddress,
    performanceMetric: modelInfo.performanceMetric,
    active: modelInfo.active
  });
  
  // Test getTokenAddress() returns correct token
  const retrievedTokenAddress = await registry.getTokenAddress(modelId);
  console.log("✅ getTokenAddress() returns:", retrievedTokenAddress);
  console.log("✅ Token address matches:", retrievedTokenAddress === token.target);
  
  // Test getMetric() returns correct metric
  const retrievedMetric = await registry.getMetric(modelId);
  console.log("✅ getMetric() returns:", retrievedMetric);
  console.log("✅ Metric matches:", retrievedMetric === metric);
  
  // Test reverse lookup - getModelId() from token address
  const retrievedModelId = await registry.getModelId(token.target);
  console.log("✅ getModelId() returns:", retrievedModelId.toString());
  console.log("✅ Model ID matches:", retrievedModelId.toString() === modelId.toString());
  
  // Test isRegistered() and exists()
  const isRegistered = await registry.isRegistered(modelId);
  const exists = await registry.exists(modelId);
  console.log("✅ isRegistered() returns:", isRegistered);
  console.log("✅ exists() returns:", exists);
  console.log("--- End Metadata Validation ---\n");

  // Mint test tokens to contributor
  const rewardAmount = ethers.parseEther("100");
  const mintTx = await manager.mintTokens(modelId, contributor.address, rewardAmount);
  const mintReceipt = await mintTx.wait();
  
  // Verify TokensMinted event from TokenManager
  const tokensMintedLog = manager.interface.parseLog(mintReceipt.logs.find(log => 
    log.address === manager.target
  ));
  console.log("✅ TokensMinted event emitted:", {
    modelId: tokensMintedLog.args.modelId.toString(),
    recipient: tokensMintedLog.args.recipient,
    amount: ethers.formatEther(tokensMintedLog.args.amount)
  });
  
  // Verify Transfer event from HokusaiToken
  const transferLog = token.interface.parseLog(mintReceipt.logs.find(log => 
    log.address === token.target
  ));
  console.log("✅ Transfer event emitted:", {
    from: transferLog.args.from,
    to: transferLog.args.to,
    value: ethers.formatEther(transferLog.args.value)
  });
  
  const balance = await token.balanceOf(contributor.address);
  console.log("Contributor balance:", ethers.formatEther(balance));

  // Simulate burn via AuctionBurner (mock interaction)
  // Assume AuctionBurner has a burn function accepting modelId and amount
  const AuctionBurner = await ethers.getContractFactory("AuctionBurner");
  const burner = await AuctionBurner.deploy(token.target);
  console.log("AuctionBurner deployed to:", burner.target);

  // Contributor approves and burns tokens
  await token.connect(contributor).approve(burner.target, rewardAmount);
  const burnTx = await burner.connect(contributor).burn(rewardAmount);
  const burnReceipt = await burnTx.wait();
  
  // Verify TokensBurned event from AuctionBurner
  const tokensBurnedLog = burner.interface.parseLog(burnReceipt.logs.find(log => 
    log.address === burner.target
  ));
  console.log("✅ TokensBurned event emitted:", {
    user: tokensBurnedLog.args.user,
    amount: ethers.formatEther(tokensBurnedLog.args.amount)
  });
  
  // Verify Transfer event for burn (to zero address)
  const burnTransferLog = token.interface.parseLog(burnReceipt.logs.find(log => 
    log.address === token.target && log.topics[0] === token.interface.getEvent('Transfer').topicHash
  ));
  console.log("✅ Transfer (burn) event emitted:", {
    from: burnTransferLog.args.from,
    to: burnTransferLog.args.to,
    value: ethers.formatEther(burnTransferLog.args.value)
  });
  
  const finalBalance = await token.balanceOf(contributor.address);
  console.log("Final contributor balance:", ethers.formatEther(finalBalance));

  // Error/Negative Test Cases
  console.log("\n--- Error/Negative Test Cases ---");
  
  // Test 1: Attempt to retrieve invalid model
  try {
    await registry.getModel(999);
    console.log("❌ Should have failed: getModel(999)");
  } catch (error) {
    console.log("✅ getModel(999) correctly failed:", error.message.includes("Model not registered"));
  }
  
  // Test 2: Attempt to mint for unregistered model
  try {
    await manager.mintTokens(999, contributor.address, ethers.parseEther("10"));
    console.log("❌ Should have failed: mintTokens for unregistered model");
  } catch (error) {
    console.log("✅ mintTokens for unregistered model correctly failed:", error.message.includes("Model not registered"));
  }
  
  // Test 3: Attempt minting from non-admin account
  try {
    await manager.connect(contributor).mintTokens(modelId, contributor.address, ethers.parseEther("10"));
    console.log("❌ Should have failed: mintTokens from non-admin");
  } catch (error) {
    console.log("✅ mintTokens from non-admin correctly failed:", error.message.includes("Ownable"));
  }
  
  // Test 4: Attempt burn with insufficient balance
  try {
    await burner.connect(contributor).burn(ethers.parseEther("1000"));
    console.log("❌ Should have failed: burn with insufficient balance");
  } catch (error) {
    console.log("✅ burn with insufficient balance correctly failed:", error.message.includes("ERC20"));
  }
  
  // Test 5: Attempt burn without approval
  const newBurner = await AuctionBurner.deploy(token.target);
  try {
    await newBurner.connect(contributor).burn(ethers.parseEther("1"));
    console.log("❌ Should have failed: burn without approval");
  } catch (error) {
    console.log("✅ burn without approval correctly failed:", error.message.includes("allowance"));
  }
  
  // Test 6: Attempt re-registration of same token
  try {
    await registry.registerModelAutoId(token.target, "precision");
    console.log("❌ Should have failed: re-register same token");
  } catch (error) {
    console.log("✅ re-register same token correctly failed:", error.message.includes("Token already registered"));
  }
  
  // Test 7: Test token can't be minted without TokenManager
  try {
    await token.mint(contributor.address, ethers.parseEther("10"));
    console.log("❌ Should have failed: direct token mint");
  } catch (error) {
    console.log("✅ direct token mint correctly failed:", error.message.includes("Only controller"));
  }
  
  // Test 8: Test token can't be burned from without TokenManager  
  try {
    await token.burnFrom(contributor.address, ethers.parseEther("1"));
    console.log("❌ Should have failed: direct token burnFrom");
  } catch (error) {
    console.log("✅ direct token burnFrom correctly failed:", error.message.includes("Only controller"));
  }
  
  console.log("--- End Error/Negative Tests ---\n");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});