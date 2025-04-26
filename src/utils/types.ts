import { BigNumber } from 'ethers';

// Network configuration interface
export interface NetworkConfig {
  network?: string;
  rpcUrl?: string; // Making rpcUrl optional
  chainId: number;
  tokens: {
    [key: string]: string;
  };
  uniswap: {
    poolFee: number;
    swapRouter: string;
    positionManager: string; 
    factory: string;
    feeTiers: number[]; 
    createPoolIfNeeded?: boolean;
  };
  strategy: {
    checkInterval: number;
    rangeWidthPercent: number;
    slippagePercent: number;
    binanceSymbol: string;
    positionStep: number;
    rebalanceThreshold: number;
    maxTickDeviation: number;
    cycleStepDelay: number;
    dynamicFeeTier: boolean;
  };
}

// Strategy step enum for NPC LP strategy
export enum StrategyStep {
  TOKEN0_TO_TOKEN1 = 'WETH_TO_USDC', // WETH → USDC
  TOKEN1_TO_TOKEN0 = 'USDC_TO_WETH', // USDC → WETH
}

// Price data from oracle
export interface PriceData {
  uniswapPrice: number;
  timestamp: number;
}

// LP Position information
export interface PositionInfo {
  tickLower: number;
  tickUpper: number;
  liquidity: BigNumber;
  amount0: BigNumber;
  amount1: BigNumber;
  inRange: boolean;
  tokenId?: number;
  token0Amount?: BigNumber;
  token1Amount?: BigNumber;
  feeGrowthInside0LastX128?: BigNumber;
  feeGrowthInside1LastX128?: BigNumber;
  priceLower?: number;
  priceUpper?: number;
  isActive?: boolean; // Added for active position status
}

// Rebalance event data
export interface RebalanceEvent {
  timestamp: number;
  action: 'REMOVED_LIQUIDITY' | 'SWAPPED' | 'ADDED_LIQUIDITY';
  positionId?: number;
  token0Amount?: BigNumber;
  token1Amount?: BigNumber;
  token0Symbol?: string;
  token1Symbol?: string;
  price?: number;
}

// Strategy stats interface for tracking performance
export interface StrategyStats {
  initialToken0Amount: BigNumber;
  initialToken1Amount: BigNumber;
  currentToken0Amount: BigNumber;
  currentToken1Amount: BigNumber;
  currentStep: StrategyStep;
  totalVolume: BigNumber;
  totalFeesCollectedToken0: BigNumber;
  totalFeesCollectedToken1: BigNumber;
  cycleCount: number;
  profitLoss: number; // in basis points
  currentCycleProfitLoss?: number; // in basis points
  startTimestamp: number;
  lastRebalanceTimestamp?: number;
  totalRebalanceCount?: number;
  currentPositionId?: number;
}

// 1inch API response for swap
export interface OneInchSwapResponse {
  fromToken: {
    address: string;
    name: string;
    symbol: string;
    decimals: number;
    logoURI?: string;
  };
  toToken: {
    address: string;
    name: string;
    symbol: string;
    decimals: number;
    logoURI?: string;
  };
  toTokenAmount: string;
  fromTokenAmount: string;
  protocols: any[]; // Routing path through various protocols
  tx: {
    from: string;
    to: string;
    data: string;
    value: string;
    gasPrice: string;
    gas: number;
  };
  estimatedGas: number;
}

// 1inch API response for quote
export interface OneInchQuoteResponse {
  fromToken: {
    address: string;
    name: string;
    symbol: string;
    decimals: number;
    logoURI?: string;
  };
  toToken: {
    address: string;
    name: string;
    symbol: string;
    decimals: number;
    logoURI?: string;
  };
  toTokenAmount: string;
  fromTokenAmount: string;
  protocols: any[]; // Routing path through various protocols
  estimatedGas: number;
}

// 1inch API response for approval
export interface OneInchApproveResponse {
  address: string;
  allowance: string;
}

// 1inch swap parameters
export interface OneInchSwapParams {
  fromTokenAddress: string;
  toTokenAddress: string;
  amount: string;
  fromAddress: string;
  slippage: number;
  disableEstimate?: boolean;
  allowPartialFill?: boolean;
  protocols?: string;
  destReceiver?: string;
  referrerAddress?: string;
  fee?: number;
}

// Database interfaces to handle BigNumber conversion
export interface DbPositionInfo {
  tickLower: number;
  tickUpper: number;
  liquidity: string;
  amount0: string;
  amount1: string;
  inRange: boolean;
  tokenId?: number;
  token0Amount?: string;
  token1Amount?: string;
  feeGrowthInside0?: string;
  feeGrowthInside1?: string;
  priceLower?: number;
  priceUpper?: number;
  isActive?: boolean;
}

export interface DbActionEvent extends Omit<RebalanceEvent, 'token0Amount' | 'token1Amount'> {
  token0Amount?: string;
  token1Amount?: string;
}

export interface DbStrategyStats extends Omit<StrategyStats, 'totalFeesCollectedToken0' | 'totalFeesCollectedToken1' | 'initialToken0Amount' | 'initialToken1Amount' | 'currentToken0Amount' | 'currentToken1Amount' | 'totalVolume'> {
  totalFeesCollectedToken0: string;
  totalFeesCollectedToken1: string;
  initialToken0Amount: string;
  initialToken1Amount: string;
  currentToken0Amount: string;
  currentToken1Amount: string;
  totalVolumeGenerated: string;
}

// Position range calculation data
export interface PositionRangeParams {
  tickLower: number;
  tickUpper: number;
  priceLower: number;
  priceUpper: number;
  currentTick: number;
  currentPrice: number;
}

// Action types for the strategy
export type ActionEvent = RebalanceEvent & {
  type: 'REBALANCE' | 'STEP_CHANGE' | 'CYCLE_COMPLETE'; 
  step?: StrategyStep;
  cycleNumber?: number;
};

// Fee tier information
export interface FeeTierInfo {
  fee: number;
  tickSpacing: number;
  description: string;
}

// Pool analytics data for fee tier selection
export interface PoolAnalytics {
  poolAddress: string;
  feeTier: number;
  tvl: BigNumber; // Total Value Locked
  volume24h: BigNumber;
  fees24h: BigNumber;
  apy: number; // Annualized fee yield
  volatility: number; // Price volatility
  utilization: number; // Liquidity utilization
}

// Pool creation parameters
export interface PoolCreationParams {
  token0: string;
  token1: string;
  fee: number;
  sqrtPriceX96: string; // Initial price in sqrtPriceX96 format
}

// Pool creation result
export interface PoolCreationResult {
  poolAddress: string;
  token0: string;
  token1: string;
  fee: number;
  txHash: string;
  created: boolean; // True if new pool was created, false if existing pool was used
} 