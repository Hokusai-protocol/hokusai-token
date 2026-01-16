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

  const pool = new Contract(poolAddress, AMM_ABI, provider);

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

  // Execute trade
  const executeTrade = async () => {
    if (!signer || !preview || !inputAmount) return;

    setLoading(true);
    setTxStatus("Preparing transaction...");
    setError("");

    try {
      const poolWithSigner = pool.connect(signer);
      const userAddress = await signer.getAddress();
      const deadline = Math.floor(Date.now() / 1000) + 600; // 10 minutes

      if (tradeType === "buy") {
        // Approve USDC
        setTxStatus("Approving USDC...");
        const usdcAddress = await pool.reserveToken();
        const usdc = new Contract(usdcAddress, ERC20_ABI, signer);
        const amount = ethers.parseUnits(inputAmount, 6);

        const allowance = await usdc.allowance(userAddress, poolAddress);
        if (allowance < amount) {
          const approveTx = await usdc.approve(poolAddress, amount);
          await approveTx.wait();
        }

        // Execute buy
        setTxStatus("Executing buy...");
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
      } else {
        // Approve tokens
        setTxStatus("Approving tokens...");
        const tokenAddress = await pool.hokusaiToken();
        const token = new Contract(tokenAddress, ERC20_ABI, signer);
        const amount = ethers.parseEther(inputAmount);

        const allowance = await token.allowance(userAddress, poolAddress);
        if (allowance < amount) {
          const approveTx = await token.approve(poolAddress, amount);
          await approveTx.wait();
        }

        // Execute sell
        setTxStatus("Executing sell...");
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
      }
    } catch (err: any) {
      setError(err.message || "Transaction failed");
      setTxStatus("");
    } finally {
      setLoading(false);
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

  return (
    <div className="max-w-md mx-auto p-6 bg-white rounded-lg shadow-lg">
      <h2 className="text-2xl font-bold mb-4">Trade</h2>

      {/* Trade Type Toggle */}
      <div className="flex gap-2 mb-4">
        <button
          onClick={() => setTradeType("buy")}
          disabled={buyDisabled}
          className={`flex-1 py-2 rounded ${
            tradeType === "buy"
              ? "bg-green-600 text-white"
              : buyDisabled
              ? "bg-gray-200 text-gray-500"
              : "bg-gray-200"
          }`}
        >
          Buy
        </button>
        <button
          onClick={() => setTradeType("sell")}
          disabled={sellDisabled}
          className={`flex-1 py-2 rounded ${
            tradeType === "sell"
              ? "bg-red-600 text-white"
              : sellDisabled
              ? "bg-gray-200 text-gray-500"
              : "bg-gray-200"
          }`}
        >
          Sell
        </button>
      </div>

      {/* IBR Notice */}
      {tradeType === "sell" && !tradeInfo?.sellsEnabled && (
        <div className="mb-4 p-3 bg-yellow-100 rounded">
          <p className="text-sm text-yellow-800">
            Sells available in {getIBRCountdown()}
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

      {/* Execute Button */}
      <button
        onClick={executeTrade}
        disabled={
          !preview ||
          loading ||
          (tradeType === "buy" ? buyDisabled : sellDisabled)
        }
        className={`w-full py-3 rounded font-medium ${
          !preview || loading || (tradeType === "buy" ? buyDisabled : sellDisabled)
            ? "bg-gray-300 text-gray-500"
            : tradeType === "buy"
            ? "bg-green-600 text-white hover:bg-green-700"
            : "bg-red-600 text-white hover:bg-red-700"
        }`}
      >
        {loading ? "Processing..." : tradeType === "buy" ? "Buy" : "Sell"}
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
