import { ethers, BigNumber } from "ethers";
import {
	NetworkConfig,
	StrategyStats,
	InRangePositions,
	CloseBalances,
	PositionInfo,
} from "../utils/types";
import { LiquidityManager } from "./LiquidityManager";
import { OracleService } from "./OracleService";
import { DataTrackingService } from "./DataTrackingService";
import IERC20ABI from "../contracts/abis/IERC20.json";
import IUniswapV3PoolABI from "../contracts/abis/IUniswapV3Pool.json";
import { SwapService } from "./SwapService";

export class CustomPoolStrategy {
	private provider: ethers.providers.JsonRpcProvider;
	private signer: ethers.Wallet;
	private walletAddress: string;
	private liquidityManager: LiquidityManager;
	private oracleService: OracleService;
	private dataTrackingService: DataTrackingService;
	private swapService: SwapService;
	private token0: string | null = null;
	private token1: string | null = null;
	private token0Decimals: number | null = null;
	private token1Decimals: number | null = null;
	private token0Contract: ethers.Contract | null = null;
	private token1Contract: ethers.Contract | null = null;
	private poolAddress: string;
	private poolContract: ethers.Contract;
	private checkInterval: number;
	private stats: StrategyStats;
	private lastRebalancePrice: number = 0;
	private inRangePositions: InRangePositions = { upper: null, lower: null };
	private closeBalances: CloseBalances = {
		token0: BigNumber.from(0),
		token1: BigNumber.from(0),
	};
	private lastRebalanceSqrtPriceX96: BigNumber = BigNumber.from(0);

	constructor(private config: NetworkConfig, privateKey: string) {
		this.provider = new ethers.providers.JsonRpcProvider(config.rpcUrl);
		this.signer = new ethers.Wallet(privateKey, this.provider);
		this.walletAddress = this.signer.address;
		this.checkInterval = config.strategy.checkInterval;
		this.poolAddress = config.uniswap.poolAddress;

		// Initialize managers
		this.oracleService = new OracleService(config, this.provider);
		this.liquidityManager = new LiquidityManager(config, privateKey, this.provider);
		this.swapService = new SwapService(config, privateKey, this.provider);

		// Initialize data tracking service
		this.dataTrackingService = new DataTrackingService(
			config,
			privateKey,
			config.database.mongoUri,
			config.database.dbName,
			this.checkInterval
		);

		// Initialize pool contract
		this.poolContract = new ethers.Contract(
			this.poolAddress,
			IUniswapV3PoolABI,
			this.signer
		);

		// Initialize strategy stats with default values
		this.stats = {
			initialToken0Amount: BigNumber.from(0),
			initialToken1Amount: BigNumber.from(0),
			currentToken0Amount: BigNumber.from(0),
			currentToken1Amount: BigNumber.from(0),
			totalVolume: BigNumber.from(0),
			totalFeesCollectedToken0: BigNumber.from(0),
			totalFeesCollectedToken1: BigNumber.from(0),
			cycleCount: 0,
			profitLoss: 0,
			startTimestamp: Math.floor(Date.now() / 1000),
			lastRebalanceTimestamp: Math.floor(Date.now() / 1000),
			totalRebalanceCount: 0,
		};

		// Set initial close balances
		this.closeBalances = {
			token0: BigNumber.from(0),
			token1: BigNumber.from(0),
		};
	}

	/**
	 * Initialize by creating or connecting to our dedicated pool
	 */
	public async initialize(): Promise<void> {
		console.log("Initializing NPC LP Strategy...");

		// Fetch token0 and token1 from the pool contract
		this.token0 = await this.poolContract.token0();
		this.token1 = await this.poolContract.token1();

		console.log(`Pool token0: ${this.token0}`);
		console.log(`Pool token1: ${this.token1}`);

		// Initialize token contracts
		this.token0Contract = new ethers.Contract(
			this.token0!,
			IERC20ABI,
			this.signer
		);
		this.token1Contract = new ethers.Contract(
			this.token1!,
			IERC20ABI,
			this.signer
		);

		this.token0Decimals = await this.token0Contract.decimals();
		this.token1Decimals = await this.token1Contract.decimals();

		console.log(`Token0 decimals: ${this.token0Decimals}`);
		console.log(`Token1 decimals: ${this.token1Decimals}`);

		await this.liquidityManager.initialize(this.poolContract);
		await this.oracleService.initialize(
			this.token0Contract,
			this.token1Contract
		);
		await this.dataTrackingService.initialize(this.oracleService);
		await this.dataTrackingService.startTracking();

		this.liquidityManager.setSwapService(this.swapService);

		console.log("Data tracking service initialized and started");

		const token0Balance = await this.token0Contract.balanceOf(
			this.walletAddress
		);
		const token1Balance = await this.token1Contract.balanceOf(
			this.walletAddress
		);

		this.stats.initialToken0Amount = token0Balance;
		this.stats.initialToken1Amount = token1Balance;
		this.stats.currentToken0Amount = token0Balance;
		this.stats.currentToken1Amount = token1Balance;

		console.log(
			`Initial token0 balance: ${ethers.utils.formatUnits(
				this.stats.initialToken0Amount,
				this.token0Decimals!
			)}`
		);
		console.log(
			`Initial token1 balance: ${ethers.utils.formatUnits(
				this.stats.initialToken1Amount,
				this.token1Decimals!
			)}`
		);

		// Set close balances
		this.closeBalances.token0 = token0Balance;
		this.closeBalances.token1 = token1Balance;

		// Initialize and check for existing positions
		await this.initializeStrategy();
	}

	/**
	 * Initialize the strategy
	 */
	private async initializeStrategy(): Promise<void> {
		console.log("Initializing strategy...");

		// First check if we already have positions
		console.log("Checking for existing positions...");

		// Get all user positions
		const positions = await this.liquidityManager.getUserPositions();
		
		// Handle existing positions
		if (positions.length > 0) {
			console.log(`Found ${positions.length} existing positions`);
			
			// Check if we have exactly 2 positions (our expected upper and lower positions)
			if (positions.length === 2) {
				console.log("Found 2 positions, assigning as upper and lower positions");
				
				// Sort them by tick range (higher tick range is upper position)
				const sortedPositions = [...positions].sort(
					(a, b) => a.tickLower - b.tickLower
				);
				
				const lowerPositionInfo = sortedPositions[0];
				const upperPositionInfo = sortedPositions[1];
				
				// Record these positions
				this.inRangePositions.lower = lowerPositionInfo;
				this.inRangePositions.upper = upperPositionInfo;
				
				console.log(`Lower position: ${lowerPositionInfo.tokenId}, ticks [${lowerPositionInfo.tickLower}, ${lowerPositionInfo.tickUpper}]`);
				console.log(`Upper position: ${upperPositionInfo.tokenId}, ticks [${upperPositionInfo.tickLower}, ${upperPositionInfo.tickUpper}]`);
				
				return;
			} else {
				// Handle stray positions - positions that are not being tracked by the strategy
				console.log("Found unexpected number of positions, handling as stray positions");
				await this.handleStrayPositions(positions);
			}
		}

		await this.ensureBalanced5050();
		await this.rebalanceAndOpenPositions();
	}

	/**
	 * Handle stray positions that are not being tracked by the strategy
	 * @param positions List of positions found for the wallet
	 */
	private async handleStrayPositions(positions: PositionInfo[]): Promise<void> {
		for (const position of positions) {
			console.log(`Processing stray position ${position.tokenId}, ticks [${position.tickLower}, ${position.tickUpper}]`);
			
			// Record stray position detected
			await this.dataTrackingService.recordStrayPositionDetected(
				position.tokenId,
				position
			);
			
			// Close the stray position to reclaim funds
			try {
				console.log(`Closing stray position ${position.tokenId}...`);
				const result = await this.liquidityManager.closePosition(position.tokenId);
				
				// Record stray position closed
				await this.dataTrackingService.recordStrayPositionClosed(
					position.tokenId,
					result.amount0,
					result.amount1
				);
				
				// Add to our balances
				this.closeBalances.token0 = this.closeBalances.token0.add(result.amount0);
				this.closeBalances.token1 = this.closeBalances.token1.add(result.amount1);
				
				console.log(`Stray position ${position.tokenId} closed successfully`);
				console.log(`Received: ${ethers.utils.formatUnits(result.amount0, this.token0Decimals!)} token0, ${ethers.utils.formatUnits(result.amount1, this.token1Decimals!)} token1`);
			} catch (error) {
				console.error(`Error closing stray position ${position.tokenId}:`, error);
				
				// Record position close failure
				await this.dataTrackingService.recordPositionCloseFailed(
					position.tokenId,
					error
				);
			}
		}
	}

	/**
	 * Ensure we have a balanced 50/50 token0/token1 allocation
	 * @throws Error if critical rebalancing operations fail
	 */
	private async ensureBalanced5050(): Promise<void> {
		console.log("Checking if we need to rebalance to 50/50 token0/token1...");

		// Get current balances and convert to USD value
		const token0Balance = this.closeBalances.token0;
		const token1Balance = this.closeBalances.token1;

		// Get current price - always fetch fresh price for 50/50 calculation
		const priceData = await this.oracleService.getOraclePrice();
		const currentPrice = priceData.uniswapPrice;

		// Calculate USD values
		const token0Value =
			parseFloat(ethers.utils.formatUnits(token0Balance, this.token0Decimals!)) * currentPrice;
		const token1Value = parseFloat(ethers.utils.formatUnits(token1Balance, this.token1Decimals!));

		const totalValue = token0Value + token1Value;
		const targetValue = totalValue / 2;

		console.log(
			`token0 value: $${token0Value.toFixed(
				2
			)}, token1 value: $${token1Value.toFixed(2)}`
		);
		console.log(
			`Total value: $${totalValue.toFixed(
				2
			)}, Target value per token: $${targetValue.toFixed(2)}`
		);

		if (Math.abs(token0Value - token1Value) / totalValue > 0) {
			console.log("Rebalancing needed to achieve 50/50 allocation");

			if (token0Value > token1Value) {
				// Need to swap token0 to token1
				const swapAmountToken0 = ethers.utils.parseUnits(
					((token0Value - targetValue) / currentPrice).toFixed(this.token0Decimals!),
					this.token0Decimals!
				);
				console.log(
					`Swapping ${ethers.utils.formatUnits(
						swapAmountToken0,
						this.token0Decimals!
					)} token0 to token1...`
				);

				try {
					const receipt = await this.swapService.swap(
						this.token0!,
						this.token1!,
						swapAmountToken0
					);

					console.log("Swap completed");

					// Get updated balances after swap - no need to manually subtract first
					const actualToken0Balance =
						await this.token0Contract?.balanceOf(this.walletAddress);
					const actualToken1Balance =
						await this.token1Contract?.balanceOf(this.walletAddress);

					// Update closeBalances with the accurate values
					this.closeBalances.token0 = actualToken0Balance;
					this.closeBalances.token1 = actualToken1Balance;

					console.log(
						`Updated balances: ${ethers.utils.formatUnits(
							this.closeBalances.token0,
							this.token0Decimals!
						)} token0, ${ethers.utils.formatUnits(
							this.closeBalances.token1,
							this.token1Decimals!
						)} token1`
					);
				} catch (error) {
					throw new Error(`Error swapping token0 to token1: ${error}`);
				}
			} else {
				// Need to swap token1 to token0
				const swapAmountToken1 = ethers.utils.parseUnits(
					(token1Value - targetValue).toFixed(this.token1Decimals!),
					this.token1Decimals!
				);
				console.log(
					`Swapping ${ethers.utils.formatUnits(
						swapAmountToken1,
						this.token1Decimals!
					)} token1 to token0...`
				);

				try {
					// The SwapService now has built-in retry with adaptive slippage
					const receipt = await this.swapService.swap(
						this.token1!,
						this.token0!,
						swapAmountToken1
					);

					console.log(
						`Swap completed in tx: ${receipt.transactionHash}`
					);

					// Get updated balances after swap - no need to manually subtract first
					const actualToken0Balance =
						await this.token0Contract?.balanceOf(this.walletAddress);
					const actualToken1Balance =
						await this.token1Contract?.balanceOf(this.walletAddress);

					// Update closeBalances with the accurate values
					this.closeBalances.token0 = actualToken0Balance;
					this.closeBalances.token1 = actualToken1Balance;

					console.log(
						`Updated balances: ${ethers.utils.formatUnits(
							this.closeBalances.token0,
							this.token0Decimals!
						)} token0, ${ethers.utils.formatUnits(
							this.closeBalances.token1,
							this.token1Decimals!
						)} token1`
					);
				} catch (error) {
					throw new Error(`Error swapping token1 to token0: ${error}`);
				}
			}
		} else {
			console.log(
				"Allocation is already sufficiently balanced (within 10%)"
			);
		}
	}

	/**
	 * Rebalance and open new positions
	 */
	private async rebalanceAndOpenPositions(): Promise<void> {
		try {
			console.log("Creating new positions...");

			// Get current price and ticks
			const priceData = await this.oracleService.getOraclePrice();
			const currentPrice = priceData.uniswapPrice;

			console.log(`Current price: ${currentPrice}`);

			// Get tick spacing
			const tickSpacing = this.oracleService.getTickSpacing();

			const widthPercent = this.config.strategy.widthPercent;

			// Calculate price range based on width percent
			// If current price is 2500 and width is 20%, the range would be 500
			const priceRange = currentPrice * (widthPercent / 100);

			// Calculate upper and lower bounds with 5% overlap
			const overlapAmount = priceRange * 0.05;

			// Calculate price points
			const upperPositionUpperPrice = currentPrice + priceRange / 2;
			const transitionPrice = currentPrice - overlapAmount;
			const lowerPositionLowerPrice = currentPrice - priceRange / 2;

			console.log(
				`Width percent: ${widthPercent}%, Price range: ${priceRange.toFixed(
					2
				)}`
			);
			console.log(
				`Overlap amount: ${overlapAmount.toFixed(2)} (5% of range)`
			);
			console.log(
				`Price points: upper=${upperPositionUpperPrice.toFixed(
					2
				)}, transition=${transitionPrice.toFixed(
					2
				)}, lower=${lowerPositionLowerPrice.toFixed(2)}`
			);

			// Calculate raw ticks using the correct Uniswap V3 formula
			const upperPositionUpperTick = this.priceToTick(
				upperPositionUpperPrice
			);
			const transitionTick = this.priceToTick(transitionPrice);
			const lowerPositionLowerTick = this.priceToTick(
				lowerPositionLowerPrice
			);

			console.log(
				`Raw ticks: upper=${upperPositionUpperTick}, transition=${transitionTick}, lower=${lowerPositionLowerTick}`
			);

			// Align ticks to tick spacing with proper rounding:
			// - Lower bounds: round down (towards negative infinity)
			// - Upper bounds: round up (towards positive infinity)
			const alignedUpperPositionUpperTick = this.alignTick(
				upperPositionUpperTick,
				tickSpacing,
				true // Round up
			);
			const alignedTransitionTick = this.alignTick(
				transitionTick,
				tickSpacing,
				false // Round down for cleaner boundary
			);
			const alignedLowerPositionLowerTick = this.alignTick(
				lowerPositionLowerTick,
				tickSpacing,
				false // Round down
			);

			console.log(
				`Aligned ticks: upper=${alignedUpperPositionUpperTick}, transition=${alignedTransitionTick}, lower=${alignedLowerPositionLowerTick}`
			);

			// Create position tick ranges
			// Lower position: token1 only, from lower bound to transition point
			const lowerPositionTicks = {
				lower: alignedLowerPositionLowerTick,
				upper: alignedTransitionTick,
			};

			// Upper position: token0 only, from transition point to upper bound
			const upperPositionTicks = {
				lower: alignedTransitionTick,
				upper: alignedUpperPositionUpperTick,
			};

			// Calculate the actual prices at the aligned ticks for reporting
			const alignedUpperPositionUpperPrice = this.tickToPrice(
				alignedUpperPositionUpperTick
			);
			const alignedTransitionPrice = this.tickToPrice(
				alignedTransitionTick
			);
			const alignedLowerPositionLowerPrice = this.tickToPrice(
				alignedLowerPositionLowerTick
			);

			console.log(`===== Position Configuration =====`);
			console.log(
				`Lower position (token1 only): Price range ${alignedLowerPositionLowerPrice} to ${alignedTransitionPrice}`
			);
			console.log(
				`Lower position: Tick range [${lowerPositionTicks.lower}, ${lowerPositionTicks.upper}]`
			);
			console.log(
				`Upper position (token0 only): Price range ${alignedTransitionPrice} to ${alignedUpperPositionUpperPrice}`
			);
			console.log(
				`Upper position: Tick range [${upperPositionTicks.lower}, ${upperPositionTicks.upper}]`
			);
			console.log(
				`Positions meet at tick ${alignedTransitionTick} (price: ${alignedTransitionPrice})`
			);

			// Calculate total value of tokens
			const totalToken0 = this.closeBalances.token0;
			const totalToken1 = this.closeBalances.token1;
			let totalToken1Left;

			// Calculate value in token1 units (token0)
			const totalValueInToken1 = totalToken1.add(
				totalToken0
					.mul(BigNumber.from(Math.floor(currentPrice * Math.pow(10, this.token1Decimals!))))
					.div(BigNumber.from(10).pow(this.token0Decimals!))
			);

			console.log(
				`Total value: $${ethers.utils.formatUnits(
					totalValueInToken1,
					this.token1Decimals!
				)}`
			);

			// Try to create upper position first
			try {
				console.log(
					`Minting upper position with ticks [${
						upperPositionTicks.lower
					}, ${
						upperPositionTicks.upper
					}] using ${ethers.utils.formatUnits(
						totalToken0,
						this.token0Decimals!
					)} token0 and ${ethers.utils.formatUnits(
						totalToken1,
						this.token1Decimals!
					)} token1`
				);

				const upperResult = await this.liquidityManager.mintPosition(
					upperPositionTicks.lower,
					upperPositionTicks.upper,
					totalToken0,
					totalToken1,
					totalToken0.mul(98).div(100),
					BigNumber.from(0)
				);

				// token1 left after minting upper position
				totalToken1Left = totalToken1.sub(upperResult.amount1Used);

				// Get position info and set as upper position
				const upperPositionInfo =
					await this.liquidityManager.getPositionInfo(
						upperResult.tokenId
					);

				// Update position with actual amounts used
				upperPositionInfo.token0Amount = upperResult.amount0Used;
				upperPositionInfo.token1Amount = upperResult.amount1Used;

				console.log(
					`Upper position created with token ID: ${upperResult.tokenId}`
				);
				console.log(
					`Actual amounts used: ${ethers.utils.formatUnits(
						upperResult.amount0Used,
						this.token0Decimals!
					)} token0, ${ethers.utils.formatUnits(
						upperResult.amount1Used,
						this.token1Decimals!
					)} token1`
				);

				// Record this position creation in the tracking system
				await this.dataTrackingService.recordPositionCreated(
					upperResult.tokenId,
					{
						...upperPositionInfo,
						priceLower: this.liquidityManager.tickToPrice(
							upperPositionTicks.lower,
							this.token0Decimals!,
							this.token1Decimals!
						),
						priceUpper: this.liquidityManager.tickToPrice(
							upperPositionTicks.upper,
							this.token0Decimals!,
							this.token1Decimals!
						),
					}
				);

				this.inRangePositions.upper = upperPositionInfo;

				// Update remaining balances
				this.closeBalances.token0 = this.closeBalances.token0.sub(
					upperResult.amount0Used
				);
				this.closeBalances.token1 = this.closeBalances.token1.sub(
					upperResult.amount1Used
				);
			} catch (error: any) {
				console.error("Error creating upper position");
				await this.dataTrackingService.recordPositionCreationFailed(
					"upper",
					"Error creating position: " + error.toString()
				);
				throw error;
			}

			// Try to create lower position
			try {
				console.log(
					`Minting lower position with ticks [${
						lowerPositionTicks.lower
					}, ${
						lowerPositionTicks.upper
					}] using ${ethers.utils.formatUnits(
						0,
						this.token0Decimals!
					)} token0 and ${ethers.utils.formatUnits(
						totalToken1Left,
						this.token1Decimals!
					)} token1`
				);

				const lowerResult = await this.liquidityManager.mintPosition(
					lowerPositionTicks.lower,
					lowerPositionTicks.upper,
					BigNumber.from(0),
					totalToken1Left,
					BigNumber.from(0),
					totalToken1Left.mul(98).div(100) // 2% slippage
				);

				// Get position info and set as lower position
				const lowerPositionInfo =
					await this.liquidityManager.getPositionInfo(
						lowerResult.tokenId
					);

				// Update position with actual amounts used
				lowerPositionInfo.token0Amount = lowerResult.amount0Used;
				lowerPositionInfo.token1Amount = lowerResult.amount1Used;

				console.log(
					`Lower position created with token ID: ${lowerResult.tokenId}`
				);
				console.log(
					`Actual amounts used: ${ethers.utils.formatUnits(
						lowerResult.amount0Used,
						this.token0Decimals!
					)} token0, ${ethers.utils.formatUnits(
						lowerResult.amount1Used,
						this.token1Decimals!
					)} token1`
				);

				// Record this position creation in the tracking system
				await this.dataTrackingService.recordPositionCreated(
					lowerResult.tokenId,
					{
						...lowerPositionInfo,
						priceLower: this.liquidityManager.tickToPrice(
							lowerPositionTicks.lower,
							this.token0Decimals!,
							this.token1Decimals!
						),
						priceUpper: this.liquidityManager.tickToPrice(
							lowerPositionTicks.upper,
							this.token0Decimals!,
							this.token1Decimals!
						),
					}
				);

				this.inRangePositions.lower = lowerPositionInfo;

				// Update remaining balances
				this.closeBalances.token0 = this.closeBalances.token0.sub(
					lowerResult.amount0Used
				);
				this.closeBalances.token1 = this.closeBalances.token1.sub(
					lowerResult.amount1Used
				);
			} catch (error: any) {
				console.error("Error creating lower position");

				// If the upper position was created but lower failed, we need to close the upper
				// to avoid having funds locked in a single-sided position
				if (
					this.inRangePositions.upper &&
					typeof this.inRangePositions.upper.tokenId === "number"
				) {
					console.log(
						`Closing upper position ${this.inRangePositions.upper.tokenId} due to lower position creation failure`
					);
					try {
						const closeResult =
							await this.liquidityManager.closePosition(
								this.inRangePositions.upper.tokenId
							);

						// Update balances after closing
						this.closeBalances.token0 =
							this.closeBalances.token0.add(closeResult.amount0);
						this.closeBalances.token1 =
							this.closeBalances.token1.add(closeResult.amount1);

						// Clear the position reference
						this.inRangePositions.upper = null;
					} catch (closeError) {
						console.error(
							"Error closing upper position after lower position failure:",
							closeError
						);
					}
				}

				await this.dataTrackingService.recordPositionCreationFailed(
					"lower",
					"Error creating position: " + error.toString()
				);
				throw new Error("Error creating lower position: " + error);
			}

			// Set last rebalance price for future threshold checks
			this.lastRebalancePrice = currentPrice;

			console.log("Successfully created both positions");
		} catch (error) {
			console.error("Error in rebalanceAndOpenInRangePositions");
			throw error;
		}
	}

	/**
	 * Run the In-Range strategy
	 */
	private async strategy(): Promise<void> {
		console.log("Running strategy check...");

		// Get current price and tick
		const priceData = await this.oracleService.getOraclePrice();
		const currentPrice = priceData.uniswapPrice;
		const currentTick = priceData.tick;

		console.log(
			`Current price: ${currentPrice}, Current tick: ${currentTick}`
		);
		console.log(
			`Last rebalance price: ${this.lastRebalancePrice.toFixed(2)}`
		);

		const isBeyondTickThreshold =
			this.isPriceBeyondTickThreshold(currentTick);

		console.log(
			`Is price beyond configured thresholds: ${isBeyondTickThreshold}`
		);

		if (isBeyondTickThreshold) {
			console.log(`Closing positions and rebalancing`);

			// Close both positions
			try {
				// Check for null positions first
				if (
					!this.inRangePositions.lower ||
					!this.inRangePositions.upper
				) {
					console.log("No positions to close, skipping to rebalance");
				} else {
					const lowerTokenId = this.inRangePositions.lower.tokenId;
					const upperTokenId = this.inRangePositions.upper.tokenId;

					if (lowerTokenId !== undefined) {
						// Close lower position
						console.log(
							`Closing lower position ${lowerTokenId}...`
						);
						const lowerResult =
							await this.liquidityManager.closePosition(
								lowerTokenId
							);

						// Separate the principal from fees for tracking purposes
						const { fees: lowerFees } =
							this.separatePrincipalAndFees(
								this.inRangePositions.lower,
								lowerResult.amount0,
								lowerResult.amount1
							);

						// Update fee collection stats
						this.stats.totalFeesCollectedToken0 =
							this.stats.totalFeesCollectedToken0.add(
								lowerFees.amount0
							);
						this.stats.totalFeesCollectedToken1 =
							this.stats.totalFeesCollectedToken1.add(
								lowerFees.amount1
							);

						console.log(
							`Lower position fees collected: ${ethers.utils.formatUnits(
								lowerFees.amount0,
								this.token0Decimals!
							)} token0, ${ethers.utils.formatUnits(
								lowerFees.amount1,
								this.token1Decimals!
							)} token1`
						);

						// Record position closed event
						await this.dataTrackingService.recordPositionClosed(
							lowerTokenId,
							lowerResult.amount0,
							lowerResult.amount1
						);

						// Record fees collected event
						await this.dataTrackingService.recordFeesCollected(
							lowerTokenId,
							lowerFees.amount0,
							lowerFees.amount1
						);

						// Update balances
						this.closeBalances.token0 =
							this.closeBalances.token0.add(lowerResult.amount0);
						this.closeBalances.token1 =
							this.closeBalances.token1.add(lowerResult.amount1);
					}

					if (upperTokenId !== undefined) {
						// Close upper position
						console.log(
							`Closing upper position ${upperTokenId}...`
						);
						const upperResult =
							await this.liquidityManager.closePosition(
								upperTokenId
							);

						// Separate the principal from fees for tracking purposes
						const { fees: upperFees } =
							this.separatePrincipalAndFees(
								this.inRangePositions.upper,
								upperResult.amount0,
								upperResult.amount1
							);

						// Update fee collection stats
						this.stats.totalFeesCollectedToken0 =
							this.stats.totalFeesCollectedToken0.add(
								upperFees.amount0
							);
						this.stats.totalFeesCollectedToken1 =
							this.stats.totalFeesCollectedToken1.add(
								upperFees.amount1
							);

						console.log(
							`Upper position fees collected: ${ethers.utils.formatUnits(
								upperFees.amount0,
								this.token0Decimals!
							)} token0, ${ethers.utils.formatUnits(
								upperFees.amount1,
								this.token1Decimals!
							)} token1`
						);

						// Record position closed event
						await this.dataTrackingService.recordPositionClosed(
							upperTokenId,
							upperResult.amount0,
							upperResult.amount1
						);

						// Record fees collected event
						await this.dataTrackingService.recordFeesCollected(
							upperTokenId,
							upperFees.amount0,
							upperFees.amount1
						);

						// Update balances
						this.closeBalances.token0 =
							this.closeBalances.token0.add(upperResult.amount0);
						this.closeBalances.token1 =
							this.closeBalances.token1.add(upperResult.amount1);
					}
				}

				console.log(
					`Positions closed, total balances: ${ethers.utils.formatUnits(
						this.closeBalances.token0,
						this.token0Decimals!
					)} token0, ${ethers.utils.formatUnits(
						this.closeBalances.token1,
						this.token1Decimals!
					)} token1`
				);
				console.log(
					`Total fees collected: ${ethers.utils.formatUnits(
						this.stats.totalFeesCollectedToken0,
						this.token0Decimals!
					)} token0, ${ethers.utils.formatUnits(
						this.stats.totalFeesCollectedToken1,
						this.token1Decimals!
					)} token1`
				);

				// Update rebalance stats
				this.stats.lastRebalanceTimestamp = Math.floor(
					Date.now() / 1000
				);
				this.stats.totalRebalanceCount =
					(this.stats.totalRebalanceCount || 0) + 1;

				// Reset positions
				this.inRangePositions = { upper: null, lower: null };

				// Get the latest price after closing positions
				const latestPriceData =
					await this.oracleService.getOraclePrice();
				console.log(
					`Latest price after closing positions: ${latestPriceData.uniswapPrice}`
				);

				// Market went up, so we now have more USDC. Rebalance to 50/50
				await this.ensureBalanced5050();

				// Create new positions
				await this.rebalanceAndOpenPositions();

				// Update the rebalance baseline with the current sqrt price
				await this.updateRebalanceBaseline();
			} catch (error) {
				console.error("Error handling upper threshold breach:", error);
			}
		}
	}

	/**
	 * Helper method to separate principal from fees when closing a position
	 * This uses the tracked position amounts to accurately calculate fees
	 */
	private separatePrincipalAndFees(
		position: PositionInfo,
		amount0Received: BigNumber,
		amount1Received: BigNumber
	): {
		principal: { amount0: BigNumber; amount1: BigNumber };
		fees: { amount0: BigNumber; amount1: BigNumber };
	} {
		// Use position's token amounts that were stored when creating the position
		// This gives us accurate tracking of principal vs fees
		const principal0 = position.token0Amount || BigNumber.from(0);
		const principal1 = position.token1Amount || BigNumber.from(0);

		console.log(
			`Position principal amounts: ${ethers.utils.formatUnits(
				principal0,
				this.token0Decimals!
			)} token0, ${ethers.utils.formatUnits(
				principal1,
				this.token1Decimals!
			)} token1`
		);
		console.log(
			`Amount received: ${ethers.utils.formatUnits(
				amount0Received,
				this.token0Decimals!
			)} token0, ${ethers.utils.formatUnits(
				amount1Received,
				this.token1Decimals!
			)} token1`
		);

		// Calculate fees (anything above principal is considered fees)
		// Use max(0, received - principal) to avoid negative fees in case of impermanent loss
		const fees0 = amount0Received.gt(principal0)
			? amount0Received.sub(principal0)
			: BigNumber.from(0);

		const fees1 = amount1Received.gt(principal1)
			? amount1Received.sub(principal1)
			: BigNumber.from(0);

		console.log(
			`Calculated fees: ${ethers.utils.formatUnits(
				fees0,
				this.token0Decimals!
			)} token0, ${ethers.utils.formatUnits(
				fees1,
				this.token1Decimals!
			)} token1`
		);

		return {
			principal: {
				amount0: principal0,
				amount1: principal1,
			},
			fees: {
				amount0: fees0,
				amount1: fees1,
			},
		};
	}

	/**
	 * Start the strategy
	 */
	public async start(): Promise<void> {
		console.log(`Starting NPC Strategy...`);
		await this.monitoringLoop();
	}

	/**
	 * Monitor and execute the strategy
	 */
	private async monitoringLoop(): Promise<void> {
		while (true) {
			try {
				console.log(
					`\n--- Strategy Check (${new Date().toLocaleString()}) ---`
				);

				// Execute strategy
				await this.strategy();

				// Sleep for check interval
				console.log(
					`Next check in ${this.checkInterval / 1000} seconds`
				);

				await new Promise((resolve) =>
					setTimeout(resolve, this.checkInterval)
				);
			} catch (error) {
				console.error("Error in monitoring loop:", error);
				await new Promise((resolve) => setTimeout(resolve, 10000));
			}
		}
	}

	/**
	 * Update the last rebalance sqrt price
	 * Call this after successful rebalancing to reset the baseline
	 */
	private async updateRebalanceBaseline(): Promise<void> {
		try {
			// Get current sqrt price from slot0
			const [currentSqrtPriceX96] = await this.poolContract.slot0();
			this.lastRebalanceSqrtPriceX96 =
				BigNumber.from(currentSqrtPriceX96);

			// Also update the last rebalance price for backward compatibility
			const priceData = await this.oracleService.getOraclePrice();
			this.lastRebalancePrice = priceData.uniswapPrice;

			console.log(
				`Updated rebalance baseline: sqrtPrice=${this.lastRebalanceSqrtPriceX96}, price=${this.lastRebalancePrice}`
			);
		} catch (error) {
			console.error("Error updating rebalance baseline:", error);
		}
	}

	// Check if the price is beyond the configured thresholds
	private isPriceBeyondTickThreshold(currentTick: number): boolean {
		const upperPositionUpper = this.inRangePositions.upper
			?.tickUpper as number;
		const lowerPositionLower = this.inRangePositions.lower
			?.tickLower as number;

		const upperTickThreshold =
			upperPositionUpper + 2 * this.oracleService.getTickSpacing();
		const lowerTickThreshold =
			lowerPositionLower - 2 * this.oracleService.getTickSpacing();

		console.log(
			`Current tick: ${currentTick}, Upper tick threshold: ${upperTickThreshold}, Lower tick threshold: ${lowerTickThreshold}`
		);

		// Check if current price is beyond either threshold
		// For Uniswap V3:
		// - If currentTick > upperTickThreshold, price is below lower bound
		// - If currentTick < lowerTickThreshold, price is above upper bound
		const isAboveUpperThreshold = currentTick < lowerTickThreshold;
		const isBelowLowerThreshold = currentTick > upperTickThreshold;

		if (isAboveUpperThreshold) {
			console.log(
				`Price is above upper threshold (${upperTickThreshold.toFixed(
					2
				)}), should close positions`
			);
		}

		if (isBelowLowerThreshold) {
			console.log(
				`Price is below lower threshold (${lowerTickThreshold.toFixed(
					2
				)}), should close positions`
			);
		}

		return isAboveUpperThreshold || isBelowLowerThreshold;
	}

	/**
	 * Convert price to tick using Uniswap V3 formula
	 * @param price The price to convert
	 * @returns The corresponding tick
	 */
	private priceToTick(price: number): number {
		return (
			(Math.log(price) -
				(this.token0Decimals! - this.token1Decimals!) * Math.log(10)) /
			Math.log(1.0001)
		);
	}

	/**
	 * Convert tick to price using Uniswap V3 formula
	 * @param tick The tick to convert
	 * @returns The corresponding price
	 */
	private tickToPrice(tick: number): number {
		return (
			Math.pow(1.0001, tick) *
			10 ** (this.token0Decimals! - this.token1Decimals!)
		);
	}

	/**
	 * Align tick to the nearest tickSpacing
	 * @param tick The tick to align
	 * @param tickSpacing The tick spacing
	 * @param roundUp Whether to round up or down
	 * @returns The aligned tick
	 */
	private alignTick(
		tick: number,
		tickSpacing: number,
		roundUp: boolean
	): number {
		// Use the LiquidityManager's implementation which handles negative ticks correctly
		return this.liquidityManager.alignTickToSpacing(
			tick,
			tickSpacing,
			roundUp
		);
	}
}
