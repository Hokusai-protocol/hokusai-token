/**
 * Trading Interface Component
 *
 * Complete trading UI for Hokusai AMM pools featuring:
 * - Real-time price impact preview
 * - Slippage tolerance selector
 * - IBR countdown timer
 * - Transaction status tracking
 * - Error handling and validation
 *
 * Usage:
 *   <TradingInterface
 *     poolAddress="0x..."
 *     provider={provider}
 *     signer={signer}
 *   />
 */

import React, { useState, useEffect } from "react";
import { ethers, Contract } from "ethers";

const AMM_ABI = [
  "function getPoolState() view returns (uint256 reserve, uint256 supply, uint256 price, uint256 reserveRatio, uint256 tradeFeeRate, uint16 protocolFeeRate)",
  "function getTradeInfo() view returns (bool sellsEnabled, uint256 ibrEndTime, bool isPaused)",
  "function calculateBuyImpact(uint256) view returns (uint256 tokensOut, uint256 priceImpact, uint256 newSpotPrice)",
  "function calculateSellImpact(uint256) view returns (uint256 reserveOut, uint256 priceImpact, uint256 newSpotPrice)",
  "function buy(uint256 reserveIn, uint256 minTokensOut, address to, uint256 deadline) returns (uint256)",
  "function sell(uint256 tokensIn, uint256 minReserveOut, address to, uint256 deadline) returns (uint256)",
  "function reserveToken() view returns (address)",
  "function hokusaiToken() view returns (address)",
];

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
  "function allowance(address, address) view returns (uint256)",
];

interface TradingInterfaceProps {
  poolAddress: string;
  provider: ethers.Provider;
  signer: ethers.Signer;
  expectedChainId?: number; // Defaults to Sepolia (11155111)
}

interface PoolState {
  reserve: bigint;
  supply: bigint;
  price: bigint;
  reserveRatio: bigint;
  tradeFeeRate: bigint;
  protocolFeeRate: bigint;
}

interface TradeInfo {
  sellsEnabled: boolean;
  ibrEndTime: bigint;
  isPaused: boolean;
}

interface TradePreview {
  tokensOut?: string;
  reserveOut?: string;
  priceImpact: number;
  newPrice: string;
}

export const TradingInterface: React.FC<TradingInterfaceProps> = ({
  poolAddress,
  provider,
  signer,
  expectedChainId = 11155111, // Sepolia
}) => {
  const [tradeType, setTradeType] = useState<"buy" | "sell">("buy");
  const [inputAmount, setInputAmount] = useState("");
  const [slippage, setSlippage] = useState(100); // 1% in bps
  const [preview, setPreview] = useState<TradePreview | null>(null);
  const [poolState, setPoolState] = useState<PoolState | null>(null);
  const [tradeInfo, setTradeInfo] = useState<TradeInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [txStatus, setTxStatus] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [currentChainId, setCurrentChainId] = useState<number | null>(null);
  const [approvalPending, setApprovalPending] = useState(false);
  const [approvalComplete, setApprovalComplete] = useState(false);

  const pool = new Contract(poolAddress, AMM_ABI, provider);

  // Check current network
  useEffect(() => {
    const checkNetwork = async () => {
      try {
        const network = await provider.getNetwork();
        setCurrentChainId(Number(network.chainId));
      } catch (err) {
        console.error("Error checking network:", err);
      }
    };

    checkNetwork();
  }, [provider]);

  // Fetch pool state
  useEffect(() => {
    const fetchPoolState = async () => {
      try {
        const [reserve, supply, price, reserveRatio, tradeFeeRate, protocolFeeRate] =
          await pool.getPoolState();

        setPoolState({
          reserve,
          supply,
          price,
          reserveRatio,
          tradeFeeRate,
          protocolFeeRate,
        });
      } catch (err) {
        console.error("Error fetching pool state:", err);
      }
    };

    fetchPoolState();
    const interval = setInterval(fetchPoolState, 10000); // Update every 10s
    return () => clearInterval(interval);
  }, [poolAddress]);

  // Fetch trade info
  useEffect(() => {
    const fetchTradeInfo = async () => {
      try {
        const [sellsEnabled, ibrEndTime, isPaused] = await pool.getTradeInfo();
        setTradeInfo({ sellsEnabled, ibrEndTime, isPaused });
      } catch (err) {
        console.error("Error fetching trade info:", err);
      }
    };

    fetchTradeInfo();
    const interval = setInterval(fetchTradeInfo, 10000);
    return () => clearInterval(interval);
  }, [poolAddress]);

  // Update preview when input changes
  useEffect(() => {
    if (!inputAmount || isNaN(Number(inputAmount))) {
      setPreview(null);
      return;
    }

    const updatePreview = async () => {
      try {
        if (tradeType === "buy") {
          const amount = ethers.parseUnits(inputAmount, 6); // USDC is 6 decimals
          const [tokensOut, priceImpact, newSpotPrice] =
            await pool.calculateBuyImpact(amount);

          setPreview({
            tokensOut: ethers.formatEther(tokensOut),
            priceImpact: Number(priceImpact) / 100,
            newPrice: ethers.formatUnits(newSpotPrice, 6),
          });
        } else {
          const amount = ethers.parseEther(inputAmount); // Tokens are 18 decimals
          const [reserveOut, priceImpact, newSpotPrice] =
            await pool.calculateSellImpact(amount);

          setPreview({
            reserveOut: ethers.formatUnits(reserveOut, 6),
            priceImpact: Number(priceImpact) / 100,
            newPrice: ethers.formatUnits(newSpotPrice, 6),
          });
        }
        setError("");
      } catch (err: any) {
        setError(err.message);
        setPreview(null);
      }
    };

    const timer = setTimeout(updatePreview, 300); // Debounce
    return () => clearTimeout(timer);
  }, [inputAmount, tradeType, poolAddress]);

  // Get price impact color
  const getImpactColor = (impact: number): string => {
    if (impact < 1) return "text-green-600";
    if (impact < 5) return "text-yellow-600";
    return "text-red-600";
  };

  // Calculate minOut with slippage
  const calculateMinOut = (expectedOut: bigint): bigint => {
    const slippageMultiplier = BigInt(10000 - slippage);
    return (expectedOut * slippageMultiplier) / 10000n;
  };

  // Parse ethers errors for specific conditions
  const parseTradeError = (err: any): string => {
    const message = err.message || '';
    const reason = err.reason || '';

    if (message.includes('deadline') || reason.includes('expired')) {
      return 'Transaction deadline passed — please retry';
    }
    if (message.includes('slippage') || message.includes('insufficient output')) {
      return 'Price moved too much — adjust slippage or retry';
    }
    return message || 'Transaction failed';
  };

  // Approve token for spending
  const approveToken = async (tokenAddress: string, amount: bigint): Promise<boolean> => {
    if (!signer) return false;

    setApprovalPending(true);
    setTxStatus("Step 1: Approve token for spending...");
    setError("");

    try {
      const token = new Contract(tokenAddress, ERC20_ABI, signer);
      const userAddress = await signer.getAddress();
      const allowance = await token.allowance(userAddress, poolAddress);

      if (allowance >= amount) {
        setApprovalComplete(true);
        return true;
      }

      const approveTx = await token.approve(poolAddress, amount);
      setTxStatus("Confirming approval...");
      await approveTx.wait();

      setApprovalComplete(true);
      setApprovalPending(false);
      setTxStatus("");
      return true;
    } catch (err: any) {
      setError(parseTradeError(err));
      setApprovalPending(false);
      return false;
    }
  };

  // Execute trade
  const executeTrade = async () => {
    if (!signer || !preview || !inputAmount || !approvalComplete) return;

    setLoading(true);
    setTxStatus("Step 2: Executing transaction...");
    setError("");

    try {
      const poolWithSigner = pool.connect(signer);
      const userAddress = await signer.getAddress();
      const deadline = Math.floor(Date.now() / 1000) + 600; // 10 minutes

      if (tradeType === "buy") {
        // Execute buy
        const amount = ethers.parseUnits(inputAmount, 6);
        const tokensOut = ethers.parseEther(preview.tokensOut!);
        const minTokensOut = calculateMinOut(tokensOut);

        const tx = await poolWithSigner.buy(
          amount,
          minTokensOut,
          userAddress,
          deadline
        );

        setTxStatus("Confirming transaction...");
        const receipt = await tx.wait();

        setTxStatus(`Success! Tx: ${receipt.hash.slice(0, 10)}...`);
        setInputAmount("");
        setApprovalComplete(false);
      } else {
        // Execute sell
        const amount = ethers.parseEther(inputAmount);
        const reserveOut = ethers.parseUnits(preview.reserveOut!, 6);
        const minReserveOut = calculateMinOut(reserveOut);

        const tx = await poolWithSigner.sell(
          amount,
          minReserveOut,
          userAddress,
          deadline
        );

        setTxStatus("Confirming transaction...");
        const receipt = await tx.wait();

        setTxStatus(`Success! Tx: ${receipt.hash.slice(0, 10)}...`);
        setInputAmount("");
        setApprovalComplete(false);
      }
    } catch (err: any) {
      setError(parseTradeError(err));
      setTxStatus("");
    } finally {
      setLoading(false);
    }
  };

  // Start approval flow
  const initiateApproval = async () => {
    if (!signer || !inputAmount) return;

    try {
      const userAddress = await signer.getAddress();
      const amount = tradeType === "buy"
        ? ethers.parseUnits(inputAmount, 6)
        : ethers.parseEther(inputAmount);

      const tokenAddress = tradeType === "buy"
        ? await pool.reserveToken()
        : await pool.hokusaiToken();

      await approveToken(tokenAddress, amount);
    } catch (err: any) {
      setError(err.message || "Approval failed");
    }
  };

  // IBR countdown
  const getIBRCountdown = (): string | null => {
    if (!tradeInfo || tradeInfo.sellsEnabled) return null;

    const now = Date.now() / 1000;
    const timeLeft = Number(tradeInfo.ibrEndTime) - now;

    if (timeLeft <= 0) return null;

    const days = Math.floor(timeLeft / 86400);
    const hours = Math.floor((timeLeft % 86400) / 3600);
    const minutes = Math.floor((timeLeft % 3600) / 60);

    return `${days}d ${hours}h ${minutes}m`;
  };

  const buyDisabled = !tradeInfo || tradeInfo.isPaused || loading;
  const sellDisabled = !tradeInfo || tradeInfo.isPaused || !tradeInfo.sellsEnabled || loading;

  const isNetworkMismatch = currentChainId && currentChainId !== expectedChainId;
  const isSellDisabledByIBR = !tradeInfo?.sellsEnabled;

  return (
    <div className="max-w-md mx-auto p-6 bg-white rounded-lg shadow-lg">
      <h2 className="text-2xl font-bold mb-4">Trade</h2>

      {/* Network Mismatch Banner */}
      {isNetworkMismatch && (
        <div className="mb-4 p-3 bg-red-100 rounded border border-red-400">
          <p className="text-sm font-semibold text-red-800 mb-2">
            ⚠️ Wrong Network
          </p>
          <p className="text-xs text-red-700 mb-2">
            Please switch to Sepolia testnet to continue trading.
          </p>
          <button
            className="text-xs bg-red-600 text-white px-3 py-1 rounded hover:bg-red-700"
            onClick={() => window.alert('Please switch network in your wallet')}
          >
            Switch to Sepolia
          </button>
        </div>
      )}

      {/* Trade Type Toggle */}
      <div className="flex gap-2 mb-4">
        <button
          onClick={() => setTradeType("buy")}
          disabled={buyDisabled || isNetworkMismatch}
          className={`flex-1 py-2 rounded ${
            tradeType === "buy"
              ? "bg-green-600 text-white"
              : (buyDisabled || isNetworkMismatch)
              ? "bg-gray-200 text-gray-500"
              : "bg-gray-200"
          }`}
        >
          Buy
        </button>
        <button
          onClick={() => setTradeType("sell")}
          disabled={sellDisabled || isNetworkMismatch}
          className={`flex-1 py-2 rounded ${
            tradeType === "sell"
              ? "bg-red-600 text-white"
              : (sellDisabled || isNetworkMismatch)
              ? "bg-gray-200 text-gray-500"
              : "bg-gray-200"
          }`}
          aria-disabled={isSellDisabledByIBR}
        >
          Sell
        </button>
      </div>

      {/* IBR Notice */}
      {tradeType === "sell" && isSellDisabledByIBR && (
        <div className="mb-4 p-3 bg-yellow-100 rounded border border-yellow-400">
          <p className="text-sm font-semibold text-yellow-800 mb-1">
            Sells disabled during IBR
          </p>
          <p className="text-xs text-yellow-700">
            Sells enabled in {getIBRCountdown()}
          </p>
        </div>
      )}

      {/* Pause Notice */}
      {tradeInfo?.isPaused && (
        <div className="mb-4 p-3 bg-red-100 rounded">
          <p className="text-sm text-red-800">Trading is currently paused</p>
        </div>
      )}

      {/* Amount Input */}
      <div className="mb-4">
        <label className="block text-sm font-medium mb-2">
          {tradeType === "buy" ? "USDC Amount" : "Token Amount"}
        </label>
        <input
          type="number"
          value={inputAmount}
          onChange={(e) => setInputAmount(e.target.value)}
          placeholder="0.0"
          className="w-full p-3 border rounded"
          disabled={loading}
        />
      </div>

      {/* Slippage Selector */}
      <div className="mb-4">
        <label className="block text-sm font-medium mb-2">
          Slippage Tolerance
        </label>
        <div className="flex gap-2">
          {[10, 50, 100, 300].map((bps) => (
            <button
              key={bps}
              onClick={() => setSlippage(bps)}
              className={`px-3 py-1 rounded ${
                slippage === bps
                  ? "bg-blue-600 text-white"
                  : "bg-gray-200"
              }`}
            >
              {bps / 100}%
            </button>
          ))}
        </div>
      </div>

      {/* Preview */}
      {preview && (
        <div className="mb-4 p-4 bg-gray-50 rounded">
          <p className="text-sm mb-2">
            You will receive:{" "}
            <strong>
              {tradeType === "buy"
                ? `${preview.tokensOut} tokens`
                : `$${preview.reserveOut} USDC`}
            </strong>
          </p>
          <p className={`text-sm mb-2 ${getImpactColor(preview.priceImpact)}`}>
            Price Impact:{" "}
            <strong>{preview.priceImpact.toFixed(2)}%</strong>
          </p>
          <p className="text-sm">
            New Price: <strong>${preview.newPrice}</strong>
          </p>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="mb-4 p-3 bg-red-100 rounded">
          <p className="text-sm text-red-800">{error}</p>
        </div>
      )}

      {/* Transaction Status */}
      {txStatus && (
        <div className="mb-4 p-3 bg-blue-100 rounded">
          <p className="text-sm text-blue-800">{txStatus}</p>
        </div>
      )}

      {/* Two-Step Approval UI */}
      {!approvalComplete && preview && !isNetworkMismatch && (
        <>
          <button
            onClick={initiateApproval}
            disabled={approvalPending || !preview}
            className={`w-full py-3 rounded font-medium mb-2 ${
              approvalPending || !preview
                ? "bg-gray-300 text-gray-500"
                : "bg-blue-600 text-white hover:bg-blue-700"
            }`}
          >
            {approvalPending ? "Approving..." : "Step 1: Approve"}
          </button>
          {approvalPending && (
            <p className="text-xs text-gray-600 text-center mb-2">
              Waiting for approval confirmation...
            </p>
          )}
        </>
      )}

      {/* Execute Button (Step 2) */}
      <button
        onClick={executeTrade}
        disabled={
          !preview ||
          loading ||
          (tradeType === "buy" ? buyDisabled : sellDisabled) ||
          isNetworkMismatch ||
          !approvalComplete
        }
        className={`w-full py-3 rounded font-medium ${
          !preview || loading || (tradeType === "buy" ? buyDisabled : sellDisabled) || isNetworkMismatch || !approvalComplete
            ? "bg-gray-300 text-gray-500"
            : tradeType === "buy"
            ? "bg-green-600 text-white hover:bg-green-700"
            : "bg-red-600 text-white hover:bg-red-700"
        }`}
      >
        {!approvalComplete
          ? "Complete Step 1 First"
          : loading
          ? "Processing..."
          : `Step 2: ${tradeType === "buy" ? "Buy" : "Sell"}`}
      </button>

      {/* Pool Info */}
      {poolState && (
        <div className="mt-6 pt-4 border-t">
          <h3 className="text-sm font-medium mb-2">Pool Info</h3>
          <div className="text-xs space-y-1">
            <p>Reserve: ${ethers.formatUnits(poolState.reserve, 6)}</p>
            <p>Supply: {ethers.formatEther(poolState.supply)} tokens</p>
            <p>Price: ${ethers.formatUnits(poolState.price, 6)}</p>
            <p>CRR: {Number(poolState.reserveRatio) / 10000}%</p>
          </div>
        </div>
      )}
    </div>
  );
};
