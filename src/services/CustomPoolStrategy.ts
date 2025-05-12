import { ethers, BigNumber } from "ethers";
import {
	NetworkConfig,
	StrategyStats,
	StrategyStep,
	InRangePositions,
	CloseBalances,
	PositionInfo,
} from "../utils/types";
import { PoolManager } from "./PoolManager";
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
	private poolManager: PoolManager;
	private liquidityManager: LiquidityManager;
	private oracleService: OracleService;
	private dataTrackingService: DataTrackingService;
	private swapService: SwapService;
	private token0: string;
	private token1: string;
  private token0Decimals: number = 18;
  private token1Decimals: number = 18;
	private token0Contract: ethers.Contract;
	private token1Contract: ethers.Contract;
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

	constructor(
		private config: NetworkConfig,
		privateKey: string,
		mongoUri: string
	) {
		this.provider = new ethers.providers.JsonRpcProvider(config.rpcUrl);
		this.signer = new ethers.Wallet(privateKey, this.provider);
		this.walletAddress = this.signer.address;
		this.token0 = config.tokens.token0;
		this.token1 = config.tokens.token1;
		this.checkInterval = config.strategy.checkInterval;

		// Initialize managers
		this.poolManager = new PoolManager(config, privateKey);
		this.oracleService = new OracleService(config, privateKey, this.poolManager);
		this.liquidityManager = new LiquidityManager(
			config,
			privateKey,
			this.oracleService
		);
		this.swapService = new SwapService(config, privateKey);

		// Initialize data tracking service
		this.dataTrackingService = new DataTrackingService(
			config,
			privateKey,
			mongoUri,
			"uniswap_strategy",
			this.checkInterval,
      this.oracleService
		);

		// Initialize token contracts
		this.token0Contract = new ethers.Contract(
			this.token0,
			IERC20ABI,
			this.signer
		);
		this.token1Contract = new ethers.Contract(
			this.token1,
			IERC20ABI,
			this.signer
		);

    this.poolAddress = config.uniswap.poolAddress;

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
			token0: BigNumber.from(0), // WETH
			token1: BigNumber.from(0), // USDC
		};
	}

	/**
	 * Initialize by creating or connecting to our dedicated pool
	 */
	public async initialize(): Promise<void> {
		console.log("Initializing NPC LP Strategy...");

		// Ensure token order (token0 < token1 in Uniswap V3)
		const [sortedToken0, sortedToken1] =
			ethers.utils.getAddress(this.token0) <
			ethers.utils.getAddress(this.token1)
				? [this.token0, this.token1]
				: [this.token1, this.token0];

		// Apply the sorted token order
		this.token0 = sortedToken0;
		this.token1 = sortedToken1;
		
		// Update token contracts based on sorted order
		this.token0Contract = new ethers.Contract(
			this.token0,
			IERC20ABI,
			this.signer
		);
		this.token1Contract = new ethers.Contract(
			this.token1,
			IERC20ABI,
			this.signer
		);

    this.token0Decimals = await this.token0Contract.decimals();
    this.token1Decimals = await this.token1Contract.decimals();

    console.log(`Token0 decimals: ${this.token0Decimals}`);
    console.log(`Token1 decimals: ${this.token1Decimals}`);

		await this.liquidityManager.initialize(this.poolContract);
    await this.oracleService.initialize(this.poolContract);
		await this.dataTrackingService.initialize(this.poolContract);
		await this.dataTrackingService.startTracking();

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
			`Initial WETH balance: ${ethers.utils.formatEther(
				this.stats.initialToken0Amount
			)}`
		);
		console.log(
			`Initial USDC balance: ${ethers.utils.formatUnits(
				this.stats.initialToken1Amount,
				6
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

    // if(positions.length == 2) {
    //   const upperPositionInfo = positions[0];
    //   const lowerPositionInfo = positions[1];

    //   return;

    //   this.inRangePositions.upper = upperPositionInfo;
    //   this.inRangePositions.lower = lowerPositionInfo;
    // }

    if(positions.length > 0) {
      throw new Error("Existing positions found, aborting");
    }

    await this.ensureBalanced5050();
    await this.rebalanceAndOpenPositions();
	}

	/**
	 * Ensure we have a balanced 50/50 WETH/USDC allocation
	 * @throws Error if critical rebalancing operations fail
	 */
	private async ensureBalanced5050(): Promise<void> {
		console.log("Checking if we need to rebalance to 50/50 WETH/USDC...");

		// Get current balances and convert to USD value
		const wethBalance = this.closeBalances.token0;
		const usdcBalance = this.closeBalances.token1;

		// Get current price - always fetch fresh price for 50/50 calculation
		const priceData = await this.oracleService.getOraclePrice();
		const currentPrice = priceData.uniswapPrice;

		// Calculate USD values
		const wethValue = parseFloat(ethers.utils.formatEther(wethBalance)) * currentPrice;
		const usdcValue = parseFloat(ethers.utils.formatUnits(usdcBalance, 6));

		const totalValue = wethValue + usdcValue;
		const targetValue = totalValue / 2;

		console.log(
			`WETH value: $${wethValue.toFixed(
				2
			)}, USDC value: $${usdcValue.toFixed(2)}`
		);
		console.log(
			`Total value: $${totalValue.toFixed(
				2
			)}, Target value per token: $${targetValue.toFixed(2)}`
		);

		// Check if rebalancing is needed (if difference is more than 10% of total)
		if (Math.abs(wethValue - usdcValue) / totalValue > 0.1) {
			console.log("Rebalancing needed to achieve 50/50 allocation");

			if (wethValue > usdcValue) {
				// Need to swap WETH to USDC
				const swapAmountWeth = ethers.utils.parseEther(
					((wethValue - targetValue) / currentPrice).toFixed(18)
				);
				console.log(
					`Swapping ${ethers.utils.formatEther(
						swapAmountWeth
					)} WETH to USDC...`
				);

				try {
					// The SwapService now has built-in retry with adaptive slippage
					const receipt = await this.swapService.swap(
						this.token0,
						this.token1,
						swapAmountWeth
					);

					console.log(
						`Swap completed in tx: ${receipt.transactionHash}`
					);

					// Update closeBalances directly instead of querying the chain again
					this.closeBalances.token0 =
						this.closeBalances.token0.sub(swapAmountWeth);

					// Get updated balances after swap
					const actualWethBalance = await this.token0Contract.balanceOf(
						this.walletAddress
					);
					const actualUsdcBalance = await this.token1Contract.balanceOf(
						this.walletAddress
					);

					// Update closeBalances with the accurate values
					this.closeBalances.token0 = actualWethBalance;
					this.closeBalances.token1 = actualUsdcBalance;

					console.log(
						`Updated balances: ${ethers.utils.formatEther(
							this.closeBalances.token0
						)} WETH, ${ethers.utils.formatUnits(
							this.closeBalances.token1,
							6
						)} USDC`
					);
				} catch (error) {
					throw new Error(`Error swapping WETH to USDC: ${error}`);
				}
			} else {
				// Need to swap USDC to WETH
				const swapAmountUsdc = ethers.utils.parseUnits(
					(usdcValue - targetValue).toFixed(6),
					6
				);
				console.log(
					`Swapping ${ethers.utils.formatUnits(
						swapAmountUsdc,
						6
					)} USDC to WETH...`
				);

				try {
					// The SwapService now has built-in retry with adaptive slippage
					const receipt = await this.swapService.swap(
						this.token1,
						this.token0,
						swapAmountUsdc
					);

					console.log(
						`Swap completed in tx: ${receipt.transactionHash}`
					);

					// Update closeBalances directly instead of querying the chain again
					this.closeBalances.token1 =
						this.closeBalances.token1.sub(swapAmountUsdc);

					// Get updated balances after swap
					const actualWethBalance = await this.token0Contract.balanceOf(
						this.walletAddress
					);
					const actualUsdcBalance = await this.token1Contract.balanceOf(
						this.walletAddress
					);

					// Update closeBalances with the accurate values
					this.closeBalances.token0 = actualWethBalance;
					this.closeBalances.token1 = actualUsdcBalance;

					console.log(
						`Updated balances: ${ethers.utils.formatEther(
							this.closeBalances.token0
						)} WETH, ${ethers.utils.formatUnits(
							this.closeBalances.token1,
							6
						)} USDC`
					);
				} catch (error) {
					throw new Error(`Error swapping USDC to WETH: ${error}`);
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

			console.log(
				`Current price: ${currentPrice}`
			);

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
			const upperPositionUpperTick = this.priceToTick(upperPositionUpperPrice);
			const transitionTick = this.priceToTick(transitionPrice);
			const lowerPositionLowerTick = this.priceToTick(lowerPositionLowerPrice);

			console.log(
				`Raw ticks: upper=${upperPositionUpperTick}, transition=${transitionTick}, lower=${lowerPositionLowerTick}`
			);

			// Align ticks to tick spacing with proper rounding:
			// - Lower bounds: round down (towards negative infinity)
			// - Upper bounds: round up (towards positive infinity)
			const alignedUpperPositionUpperTick = this.alignTick(
				upperPositionUpperTick,
				tickSpacing,
				"up"
			);
			const alignedTransitionTick = this.alignTick(
				transitionTick,
				tickSpacing,
				"down"
			); // Use down for cleaner boundary
			const alignedLowerPositionLowerTick = this.alignTick(
				lowerPositionLowerTick,
				tickSpacing,
				"down"
			);

			console.log(
				`Aligned ticks: upper=${alignedUpperPositionUpperTick}, transition=${alignedTransitionTick}, lower=${alignedLowerPositionLowerTick}`
			);

			// Create position tick ranges
			// Lower position: USDC only, from lower bound to transition point
			const lowerPositionTicks = {
				lower: alignedLowerPositionLowerTick,
				upper: alignedTransitionTick,
			};

			// Upper position: WETH only, from transition point to upper bound
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
				`Lower position (USDC only): Price range ${alignedLowerPositionLowerPrice} to ${alignedTransitionPrice}`
			);
			console.log(
				`Lower position: Tick range [${lowerPositionTicks.lower}, ${lowerPositionTicks.upper}]`
			);
			console.log(
				`Upper position (WETH only): Price range ${alignedTransitionPrice} to ${alignedUpperPositionUpperPrice}`
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

			// Calculate value in token1 units (USDC)
			const totalValueInToken1 = totalToken1.add(
				totalToken0
					.mul(BigNumber.from(Math.floor(currentPrice * 1e6)))
					.div(BigNumber.from(10).pow(18))
			);

			console.log(
				`Total value: $${ethers.utils.formatUnits(
					totalValueInToken1,
					6
				)}`
			);

			// Try to create upper position first
			try {

				console.log(
					`Minting upper position with ticks [${
						upperPositionTicks.lower
					}, ${
						upperPositionTicks.upper
					}] using ${ethers.utils.formatEther(
						totalToken0
					)} WETH and ${ethers.utils.formatUnits(
						totalToken1.mul(ethers.utils.parseUnits("10", 4)).div(ethers.utils.parseUnits("100", 4)),
						6
					)} USDC`
				);

				const upperResult = await this.liquidityManager.mintPosition(
					upperPositionTicks.lower,
					upperPositionTicks.upper,
					totalToken0,
					totalToken1,
          totalToken0.mul(98).div(100),
          BigNumber.from(0)
				);

        // usdc left after minting upper position
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
					`Actual amounts used: ${ethers.utils.formatEther(
						upperResult.amount0Used
					)} WETH, ${ethers.utils.formatUnits(
						upperResult.amount1Used,
						6
					)} USDC`
				);

				// Record this position creation in the tracking system
				await this.dataTrackingService.recordPositionCreated(
					upperResult.tokenId,
					{
						...upperPositionInfo,
						priceLower: this.liquidityManager.tickToPrice(
							upperPositionTicks.lower
						),
						priceUpper: this.liquidityManager.tickToPrice(
							upperPositionTicks.upper
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
					}] using ${ethers.utils.formatEther(
						0
					)} WETH and ${ethers.utils.formatUnits(
						totalToken1Left,
						6
					)} USDC`
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
					`Actual amounts used: ${ethers.utils.formatEther(
						lowerResult.amount0Used
					)} WETH, ${ethers.utils.formatUnits(
						lowerResult.amount1Used,
						6
					)} USDC`
				);

				// Record this position creation in the tracking system
				await this.dataTrackingService.recordPositionCreated(
					lowerResult.tokenId,
					{
						...lowerPositionInfo,
						priceLower: this.liquidityManager.tickToPrice(
							lowerPositionTicks.lower
						),
						priceUpper: this.liquidityManager.tickToPrice(
							lowerPositionTicks.upper
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

			console.log(
				"Successfully created both positions"
			);
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

		const isBeyondTickThreshold = this.isPriceBeyondTickThreshold(currentTick);

		console.log(`Is price beyond configured thresholds: ${isBeyondTickThreshold}`);

		// Check if price change exceeds threshold OR beyond the tick threshold
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
							`Lower position fees collected: ${ethers.utils.formatEther(
								lowerFees.amount0
							)} WETH, ${ethers.utils.formatUnits(
								lowerFees.amount1,
								6
							)} USDC`
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
							`Upper position fees collected: ${ethers.utils.formatEther(
								upperFees.amount0
							)} WETH, ${ethers.utils.formatUnits(
								upperFees.amount1,
								6
							)} USDC`
						);

						// Update balances
						this.closeBalances.token0 =
							this.closeBalances.token0.add(upperResult.amount0);
						this.closeBalances.token1 =
							this.closeBalances.token1.add(upperResult.amount1);
					}
				}

				console.log(
					`Positions closed, total balances: ${ethers.utils.formatEther(
						this.closeBalances.token0
					)} WETH, ${ethers.utils.formatUnits(
						this.closeBalances.token1,
						6
					)} USDC`
				);
				console.log(
					`Total fees collected: ${ethers.utils.formatEther(
						this.stats.totalFeesCollectedToken0
					)} WETH, ${ethers.utils.formatUnits(
						this.stats.totalFeesCollectedToken1,
						6
					)} USDC`
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
			`Position principal amounts: ${ethers.utils.formatEther(
				principal0
			)} WETH, ${ethers.utils.formatUnits(principal1, 6)} USDC`
		);
		console.log(
			`Amount received: ${ethers.utils.formatEther(
				amount0Received
			)} WETH, ${ethers.utils.formatUnits(amount1Received, 6)} USDC`
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
			`Calculated fees: ${ethers.utils.formatEther(
				fees0
			)} WETH, ${ethers.utils.formatUnits(fees1, 6)} USDC`
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
			this.lastRebalanceSqrtPriceX96 = BigNumber.from(currentSqrtPriceX96);

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
    const upperPositionUpper = this.inRangePositions.upper?.tickUpper as number;
    const lowerPositionLower = this.inRangePositions.lower?.tickLower as number;

    const upperTickThreshold = upperPositionUpper + 2 * this.oracleService.getTickSpacing();
    const lowerTickThreshold = lowerPositionLower - 2 * this.oracleService.getTickSpacing();

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
		return (Math.log(price)- (this.token0Decimals - this.token1Decimals) * Math.log(10)) / Math.log(1.0001);
	}

	/**
	 * Convert tick to price using Uniswap V3 formula
	 * @param tick The tick to convert
	 * @returns The corresponding price
	 */
	private tickToPrice(tick: number): number {
		return Math.pow(1.0001, tick) * 10** (this.token0Decimals - this.token1Decimals);
	}

	/**
	 * Align tick to the nearest tickSpacing
	 * @param tick The tick to align
	 * @param tickSpacing The tick spacing
	 * @param round Whether to round up or down
	 * @returns The aligned tick
	 */
	private alignTick(
		tick: number,
		tickSpacing: number,
		round: "down" | "up"
	): number {
    const remainder = tick % tickSpacing;
    
    // If tick is already aligned, return it as is
    if (remainder === 0) {
        return tick;
    }
    
    // Round based on the direction (down or up)
    if (round === "down") {
        return tick - remainder; // Round down to the previous multiple
    } else {
        return tick + (tickSpacing - remainder); // Round up to the next multiple
    }
	}
}
