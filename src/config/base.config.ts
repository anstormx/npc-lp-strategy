import dotenv from 'dotenv';
dotenv.config();

export default {
  chainId: 8453, // Base mainnet chainId
  rpcUrl: process.env.RPC_URL,
  tokens: {
    WETH: "0x4200000000000000000000000000000000000006", // WETH on Base mainnet
    USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" // USDC on Base mainnet
  },
  uniswap: {
    positionManager: "0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1", // Uniswap V3 NonfungiblePositionManager on Base mainnet
    swapRouter: "0x2626664c2603336E57B271c5C0b26F421741e481", // Uniswap V3 SwapRouter on Base mainnet
    factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD", // Uniswap V3 Factory on Base mainnet
    poolFee: 3000, // 0.30% fee tier (default)
    feeTiers: [500, 3000, 10000], // Available fee tiers: 0.05%, 0.3%, 1%
  },
  strategy: {
    checkInterval: 5,
    rangeWidthPercent: 5,
    slippagePercent: 0.5,
    binanceSymbol: "ETHUSDT",
    positionStep: 1,
    rebalanceThreshold: 0.5,
    maxTickDeviation: 45,
    cycleStepDelay: 3600,
    dynamicFeeTier: false
  }
}; 