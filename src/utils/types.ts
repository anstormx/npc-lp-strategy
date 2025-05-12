import { BigNumber } from "ethers";

// Network configuration interface
export interface NetworkConfig {
	network: string;
	rpcUrl: string;
	chainId: number;
	uniswap: {
		swapRouter: string;
		positionManager: string;
		factory: string;
		poolAddress: string;
	};
	strategy: {
		checkInterval: number;
		widthPercent: number;
	};
    database: {
        mongoUri: string;
        dbName: string;
    }
}

// Price data from oracle
export interface PriceData {
	uniswapPrice: number;
	timestamp: number;
	tick: number;
}

// LP Position information
export interface PositionInfo {
	tickLower: number;
	tickUpper: number;
	liquidity: BigNumber;
	amount0?: BigNumber;
	amount1?: BigNumber;
	inRange: boolean;
	tokenId: number;
	token0Amount?: BigNumber;
	token1Amount?: BigNumber;
	feeGrowthInside0LastX128: BigNumber;
	feeGrowthInside1LastX128: BigNumber;
	priceLower: number;
	priceUpper: number;
	isActive: boolean;
}

// In-Range strategy positions
export interface InRangePositions {
	upper: PositionInfo | null; // Position with higher price range (WETH)
	lower: PositionInfo | null; // Position with lower price range (USDC)
}

// Close balances for in-range strategy
export interface CloseBalances {
	token0: BigNumber; // WETH
	token1: BigNumber; // USDC
}

// Strategy stats interface for tracking performance
export interface StrategyStats {
	initialToken0Amount: BigNumber;
	initialToken1Amount: BigNumber;
	currentToken0Amount: BigNumber;
	currentToken1Amount: BigNumber;
	totalVolume: BigNumber;
	totalFeesCollectedToken0: BigNumber;
	totalFeesCollectedToken1: BigNumber;
	cycleCount: number;
	profitLoss: number;
	startTimestamp: number;
	lastRebalanceTimestamp?: number;
	totalRebalanceCount?: number;
}

// Position range calculation data (needed for OracleService)
export interface PositionRangeParams {
	tickLower: number;
	tickUpper: number;
	priceLower: number;
	priceUpper: number;
	currentTick: number;
	currentPrice: number;
}

// Database interfaces (needed for DatabaseService)
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

export interface DbActionEvent {
	type: ActionType;
	timestamp: number;
	tokenId?: number;
	token0Amount?: string;
	token1Amount?: string;
	data?: any;
}

export interface DbStrategyStats {
	cycleCount: number;
	profitLoss: number;
	startTimestamp: number;
	lastRebalanceTimestamp?: number;
	totalRebalanceCount?: number;
	totalFeesCollectedToken0: string;
	totalFeesCollectedToken1: string;
	initialToken0Amount: string;
	initialToken1Amount: string;
	currentToken0Amount: string;
	currentToken1Amount: string;
	totalVolumeGenerated: string;
}

// Action type enum
export enum ActionType {
	PRICE_DATA_COLLECTED = "PRICE_DATA_COLLECTED",
	POSITION_CREATED = "POSITION_CREATED",
	POSITION_CLOSED = "POSITION_CLOSED",
	FEES_COLLECTED = "FEES_COLLECTED",
	POSITION_OUT_OF_RANGE = "POSITION_OUT_OF_RANGE",
	POSITION_CREATION_FAILED = "POSITION_CREATION_FAILED",
	POSITION_CLOSE_FAILED = "POSITION_CLOSE_FAILED",
	SWAP_FAILED = "SWAP_FAILED",
	REBALANCE_FAILED = "REBALANCE_FAILED",
	STRAY_POSITION_DETECTED = "STRAY_POSITION_DETECTED",
	STRAY_POSITION_CLOSED = "STRAY_POSITION_CLOSED",
	STRATEGY_ERROR = "STRATEGY_ERROR",
}

// Action types for the strategy
export type ActionEvent = {
	type: ActionType;
	timestamp: number;
	tokenId?: number;
	token0Amount?: BigNumber;
	token1Amount?: BigNumber;
	data?: any;
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

export interface ApprovalResponse {
	to: string;
	data: string;
	value: string;
}

export interface AllowanceResponse {
	allowance: string;
}

export interface SwapTransaction {
	from: string;
	to: string;
	data: string;
	value: string;
	gas: number;
	gasPrice: string;
}

export interface SwapResponse {
	dstAmount: string;
	tx: SwapTransaction;
	srcToken?: {
		address: string;
		symbol: string;
		name: string;
		decimals: number;
	};
	dstToken?: {
		address: string;
		symbol: string;
		name: string;
		decimals: number;
	};
}
