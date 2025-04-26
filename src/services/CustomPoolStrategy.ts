import { ethers, BigNumber } from 'ethers';
import { NetworkConfig, StrategyStats, StrategyStep, PriceData } from '../utils/types';
import { PoolManager } from './PoolManager';
import { LiquidityManager } from './LiquidityManager';
import { OracleService } from './OracleService';
import IERC20ABI from '../contracts/abis/IERC20.json';
import IUniswapV3PoolABI from '../contracts/abis/IUniswapV3Pool.json';
import IUniswapV3FactoryABI from '../contracts/abis/IUniswapV3Factory.json';

/**
 * CustomPoolStrategy - Creates and manages a dedicated liquidity pool for WETH/USDC
 * to perform swaps without using 1inch or existing Uniswap pools
 */
export class CustomPoolStrategy {
  private provider: ethers.providers.JsonRpcProvider;
  private signer: ethers.Wallet;
  private walletAddress: string;
  private poolManager: PoolManager;
  private liquidityManager: LiquidityManager;
  private oracleService: OracleService;
  private WETH: string; // WETH
  private USDC: string; // USDC
  private WETHContract: ethers.Contract;
  private USDCContract: ethers.Contract;
  private customPoolAddress: string | null = null;
  private poolContract: ethers.Contract | null = null;
  private currentPositionId: number | null = null;
  private currentTickLower: number = 0;
  private currentTickUpper: number = 0;
  private checkInterval: number;
  private rangeWidthPercent: number;
  private stats: StrategyStats;
  private isRunning: boolean = false;
  private shouldStop: boolean = false;
  private currentStep: StrategyStep = StrategyStep.TOKEN0_TO_TOKEN1; // Default start with ETH to USDC
  private lastStepChangeTimestamp: number = 0;
  private cycleCount: number = 0;
  private poolFee: number;

  constructor(
    private config: NetworkConfig,
    privateKey: string
  ) {
    this.provider = new ethers.providers.JsonRpcProvider(config.rpcUrl);
    this.signer = new ethers.Wallet(privateKey, this.provider);
    this.walletAddress = this.signer.address;
    this.WETH = config.tokens.WETH;
    this.USDC = config.tokens.USDC;
    this.poolFee = config.uniswap.poolFee;
    this.checkInterval = config.strategy.checkInterval;
    this.rangeWidthPercent = config.strategy.rangeWidthPercent;

    // Initialize managers
    this.poolManager = new PoolManager(config, privateKey);
    this.liquidityManager = new LiquidityManager(config, privateKey);
    this.oracleService = new OracleService(config, privateKey);

    // Initialize token contracts
    this.WETHContract = new ethers.Contract(this.WETH, IERC20ABI, this.signer);
    this.USDCContract = new ethers.Contract(this.USDC, IERC20ABI, this.signer);

    // Initialize strategy stats with default values
    this.stats = {
      initialToken0Amount: BigNumber.from(0),
      initialToken1Amount: BigNumber.from(0),
      currentToken0Amount: BigNumber.from(0),
      currentToken1Amount: BigNumber.from(0),
      currentStep: this.currentStep,
      totalVolume: BigNumber.from(0),
      totalFeesCollectedToken0: BigNumber.from(0),
      totalFeesCollectedToken1: BigNumber.from(0),
      cycleCount: 0,
      profitLoss: 0,
      startTimestamp: Math.floor(Date.now() / 1000),
      lastRebalanceTimestamp: Math.floor(Date.now() / 1000),
      totalRebalanceCount: 0, // Initialize rebalance count
    };
  }

  /**
   * Initialize by creating or connecting to our dedicated pool
   */
  public async initialize(): Promise<void> {
    console.log('Initializing NPC LP Strategy...');

    // Ensure token order (token0 < token1 in Uniswap V3)
    const [sortedToken0, sortedToken1] =
      ethers.utils.getAddress(this.WETH) < ethers.utils.getAddress(this.USDC)
        ? [this.WETH, this.USDC]
        : [this.USDC, this.WETH];

    // First check if our custom pool already exists
    console.log('Checking for existing custom pool...');
    this.customPoolAddress = await this.poolManager.getPool(
      sortedToken0,
      sortedToken1,
      this.poolFee
    );

    if (!this.customPoolAddress) {
      throw new Error('No custom pool found. Please deploy a custom pool first.');
    }

    console.log(`Using pool at address: ${this.customPoolAddress}`);

    // Initialize pool contract
    this.poolContract = new ethers.Contract(
      this.customPoolAddress,
      IUniswapV3PoolABI,
      this.signer
    );

    // Initialize Oracle with pool
    await this.oracleService.initialize(this.poolContract);

    // Get initial token balances and save
    const token0Balance = await this.getTokenBalance(this.WETH);
    const token1Balance = await this.getTokenBalance(this.USDC);

    this.stats.initialToken0Amount = token0Balance;
    this.stats.initialToken1Amount = token1Balance;
    this.stats.currentToken0Amount = token0Balance;
    this.stats.currentToken1Amount = token1Balance;

    console.log(`Initial Token0 (WETH) balance: ${ethers.utils.formatEther(this.stats.initialToken0Amount)}`);
    console.log(`Initial Token1 (USDC) balance: ${ethers.utils.formatUnits(this.stats.initialToken1Amount, 6)}`);

    // Determine initial strategy step based on available tokens
    this.determineInitialStep();

    console.log(`Starting with strategy step: ${this.currentStep}`);
  }

  /**
   * Determine initial strategy step based on token balances
   */
  private async determineInitialStep(): Promise<void> {
    // If we have more ETH than USDC (in value terms), start with ETH to USDC step
    // Otherwise, start with USDC to ETH
    const ethBalanceInWei = this.stats.initialToken0Amount;
    const usdcBalanceInWei = this.stats.initialToken1Amount;

    // Get ETH price in USD
    const priceData = await this.oracleService.getOraclePrice();
    console.log("Price Data: ", priceData);

    const ethPriceInUSD = priceData.uniswapPrice;

    // Convert ETH balance to USD value
    // WETH uses 18 decimals, so we convert to ETH first
    const ethBalance = parseFloat(ethers.utils.formatEther(ethBalanceInWei));
    const ethValueInUSD = ethBalance * ethPriceInUSD;

    // Convert USDC balance to USD value
    // USDC uses 6 decimals
    const usdcValueInUSD = parseFloat(ethers.utils.formatUnits(usdcBalanceInWei, 6));

    console.log(`ETH balance: ${ethBalance} (${ethValueInUSD} USD)`);
    console.log(`USDC balance: ${usdcValueInUSD} USD`);

    // Compare USD values to determine the starting step
    if (ethValueInUSD > usdcValueInUSD) {
      this.currentStep = StrategyStep.TOKEN0_TO_TOKEN1; // ETH to USDC
      console.log('Starting with ETH to USDC (higher ETH value)');
    } else {
      this.currentStep = StrategyStep.TOKEN1_TO_TOKEN0; // USDC to ETH
      console.log('Starting with USDC to ETH (higher USDC value)');
    }

    this.stats.currentStep = this.currentStep;
  }

  /**
   * Get token balance
   */
  private async getTokenBalance(tokenAddress: string): Promise<BigNumber> {
    if (tokenAddress.toLowerCase() === this.WETH.toLowerCase()) {
      return this.WETHContract.balanceOf(this.walletAddress);
    } else {
      return this.USDCContract.balanceOf(this.walletAddress);
    }
  }

  /**
   * Start the strategy
   */
  public async start(): Promise<void> {
    if (this.isRunning) {
      console.log('Strategy is already running');
      return;
    }

    if (!this.customPoolAddress) {
      throw new Error('Strategy not initialized. Call initialize() first.');
    }

    this.isRunning = true;
    this.shouldStop = false;

    console.log('Starting Custom Pool Strategy...');
    console.log(`Current strategy step: ${this.currentStep}`);

    // Check if we already have liquidity in the pool
    if (!this.currentPositionId) {
      await this.initialSetup();
    }

    // Start the monitoring loop
    await this.monitoringLoop();
  }

  /**
   * Initial setup for providing liquidity
   */
  private async initialSetup(): Promise<void> {
    console.log(`Performing initial setup for step: ${this.currentStep}...`);

    // Calculate position range based on NPC LP strategy
    const rangeParams = await this.oracleService.calculateNpcStrategyRange(this.currentStep);

    console.log("Range Params: ", rangeParams);

    this.currentTickLower = rangeParams.tickLower;
    this.currentTickUpper = rangeParams.tickUpper;

    console.log(`Initial position range:
      Lower Tick: ${rangeParams.tickLower} (Price: ${rangeParams.priceLower})
      Upper Tick: ${rangeParams.tickUpper} (Price: ${rangeParams.priceUpper})
      Current Price: ${rangeParams.currentPrice}
    `);


    // Get updated token balances
    const token0Balance = await this.getTokenBalance(this.WETH);
    const token1Balance = await this.getTokenBalance(this.USDC);

    console.log(`Balanced token amounts for LP position:
      Token0 (ETH): ${ethers.utils.formatEther(token0Balance)}
      Token1 (USDC): ${ethers.utils.formatUnits(token1Balance, 6)}
    `);

    // Calculate optimal amounts for the position
    const { amount0, amount1 } = await this.calculateOptimalAmounts(
      this.currentTickLower,
      this.currentTickUpper
    );

    console.log(`Providing liquidity with:
      Amount0 (ETH): ${ethers.utils.formatEther(amount0)}
      Amount1 (USDC): ${ethers.utils.formatUnits(amount1, 6)}
    `);

    // Create the position
    try {

      // Get optimal fee tier for the token pair
      const optimalFee = await this.poolManager.getOptimalFeeTier(this.WETH, this.USDC);
      // Set the optimal fee tier
      this.poolFee = optimalFee;

      // this.currentPositionId = await this.liquidityManager.mintPosition(
      //   this.currentTickLower,
      //   this.currentTickUpper,
      //   amount0,
      //   amount1
      // );

      // console.log(`Created position with ID: ${this.currentPositionId} using optimal fee tier`);
      // this.stats.currentPositionId = this.currentPositionId;
      // this.stats.lastRebalanceTimestamp = Math.floor(Date.now() / 1000);
    } catch (error: any) {
      console.error(`Error creating initial position:`, error);
      throw new Error(`Failed to create initial position: ${error.message}`);
    }
  }

  /**
   * Calculate optimal amounts of tokens to provide as liquidity
   * based on position range relative to current price
   */
  private async calculateOptimalAmounts(
    tickLower: number,
    tickUpper: number
  ): Promise<{ amount0: BigNumber, amount1: BigNumber }> {
    // Get current price and tick from oracle
    const currentTickAndPrice = await this.oracleService.getCurrentTickAndPrice();
    const currentTick = currentTickAndPrice.tick;
    const currentPrice = currentTickAndPrice.price;

    // Get available token balances
    const availableToken0 = await this.getTokenBalance(this.WETH);
    const availableToken1 = await this.getTokenBalance(this.USDC);

    console.log(`Available token balances for liquidity:
      Token0 (ETH): ${ethers.utils.formatEther(availableToken0)}
      Token1 (USDC): ${ethers.utils.formatUnits(availableToken1, 6)}
      Current Price: ${currentPrice}
    `);

    console.log(`Position tick range: ${tickLower} - ${tickUpper}, Current tick: ${currentTick}`);

    // Determine if range is fully above or below market
    const isAbove = currentTick < tickLower;
    const isBelow = currentTick > tickUpper;
    const inRange = currentTick >= tickLower && currentTick <= tickUpper;

    let token0Amount = BigNumber.from(0);
    let token1Amount = BigNumber.from(0);

    if (isAbove) {
      // Range is above market – only ETH (token0) needed
      token0Amount = availableToken0;
      console.log(`Position is above current price - only providing ETH`);
    } else if (isBelow) {
      // Range is below market – only USDC (token1) needed
      token1Amount = availableToken1;
      console.log(`Position is below current price - only providing USDC`);
    } else {
      // In-range (unlikely in NPC strategy) – balance 50/50
      // This case might happen if price moved while setting up
      token0Amount = availableToken0.div(2);
      token1Amount = availableToken1.div(2);
      console.log(`Position is in range - providing balanced liquidity`);
    }

    console.log(`Providing liquidity with:
      Token0 (ETH): ${ethers.utils.formatEther(token0Amount)}
      Token1 (USDC): ${ethers.utils.formatUnits(token1Amount, 6)}
    `);

    return {
      amount0: token0Amount,
      amount1: token1Amount
    };
  }

  /**
   * Monitoring loop
   */
  private async monitoringLoop(): Promise<void> {
    console.log(`Starting monitoring loop with ${this.checkInterval}s interval`);

    while (!this.shouldStop) {
      try {
        // Skip if we don't have an active position
        if (!this.currentPositionId) {
          console.log('No active position. Creating initial position...');
          await this.initialSetup();
          continue;
        }

        console.log('\n--------- Checking Position Status ---------');

        // Get current price
        const priceData = await this.oracleService.getOraclePrice();
        const currentPrice = priceData.uniswapPrice;

        console.log(`Current ETH price: $${currentPrice}`);

        // Get position info
        const positionInfo = await this.liquidityManager.getPositionInfo(this.currentPositionId);

        console.log(`Position info: ${JSON.stringify(positionInfo, null, 2)}`);

        // Check if position is out of range
        const isOutOfRange = await this.checkIfOutOfRange(positionInfo);

        console.log(`Position is out of range: ${isOutOfRange}`);

        // Collect fees regardless of whether we rebalance
        if ((positionInfo.feeGrowthInside0LastX128?.gt(0)) || (positionInfo.feeGrowthInside1LastX128?.gt(0))) {
          console.log('Position has collected fees! Collecting them...');
          try {
            const { amount0, amount1 } = await this.liquidityManager.collectFees(this.currentPositionId);

            console.log(`Collected fees:
              Token0: ${ethers.utils.formatEther(amount0)} WETH
              Token1: ${ethers.utils.formatUnits(amount1, 6)} USDC
            `);

            // Update stats
            this.stats.totalFeesCollectedToken0 = this.stats.totalFeesCollectedToken0.add(amount0);
            this.stats.totalFeesCollectedToken1 = this.stats.totalFeesCollectedToken1.add(amount1);
          } catch (error: any) {
            console.error('Error collecting fees:', error.message);
          }
        } else {
          console.log('No fees collected yet');
        }

        // Check if we need to rebalance
        const currentTime = Math.floor(Date.now() / 1000);
        const minRebalanceInterval = 3600; // 1 hour minimum between rebalances
        const lastRebalanceTimestamp = this.stats.lastRebalanceTimestamp || currentTime;
        const timeSinceLastRebalance = currentTime - lastRebalanceTimestamp;

        if (isOutOfRange && timeSinceLastRebalance > minRebalanceInterval) {
          console.log(`Position needs rebalancing. Last rebalance was ${timeSinceLastRebalance}s ago.`);

          // Close the current position (removes liquidity and collects fees)
          console.log(`Closing position ID: ${this.currentPositionId}`);

          try {
            const { amount0, amount1 } = await this.liquidityManager.closePosition(this.currentPositionId);

            console.log(`Removed liquidity:
              Token0: ${ethers.utils.formatEther(amount0)}
              Token1: ${ethers.utils.formatUnits(amount1, 6)}
            `);

            // Update token balances
            this.stats.currentToken0Amount = await this.getTokenBalance(this.WETH);
            this.stats.currentToken1Amount = await this.getTokenBalance(this.USDC);

            // Create new position with updated range
            this.currentPositionId = null; // Reset position ID to create a new one
            await this.initialSetup();

            console.log(`Rebalanced to new position ID: ${this.currentPositionId}`);
            this.stats.lastRebalanceTimestamp = currentTime;

            // Increment rebalance count
            if (this.stats.totalRebalanceCount !== undefined) {
              this.stats.totalRebalanceCount++;
            } else {
              this.stats.totalRebalanceCount = 1;
            }
          } catch (error: any) {
            console.error('Error during rebalancing:', error.message);
          }
        } else if (isOutOfRange) {
          console.log(`Position is out of range but last rebalance was only ${timeSinceLastRebalance}s ago.`);
          console.log(`Waiting until the minimum rebalance interval (${minRebalanceInterval}s) has passed.`);
        }

        // Wait for the next check
        console.log(`Waiting ${this.checkInterval} seconds until next check...`);
        await new Promise(resolve => setTimeout(resolve, this.checkInterval * 10000));
      } catch (error: any) {
        console.error('Error in monitoring loop:', error);
        console.log('Waiting 60 seconds before retry...');
        await new Promise(resolve => setTimeout(resolve, 60 * 1000));
      }
    }

    console.log('Monitoring loop stopped');
  }

  /**
   * Stops the strategy
   */
  public stop(): void {
    console.log('Stopping strategy...');
    this.shouldStop = true;
    this.isRunning = false;

    // Log active position details if any
    if (this.currentPositionId) {
      console.log(`Strategy stopped with active position ID: ${this.currentPositionId}`);
      console.log('You can manually close this position later.');
    } else {
      console.log('No active position at time of shutdown.');
    }
  }

  /**
   * Check if the current position is out of range
   * @returns true if position is out of range and needs rebalancing
   */
  private async checkIfOutOfRange(positionInfo: any): Promise<boolean> {
    // Get current price from oracle
    const priceData = await this.oracleService.getOraclePrice();
    const currentPrice = priceData.uniswapPrice;

    console.log(`Current price: $${currentPrice}`);

    // Use safe defaults for price boundaries if they're not set
    const lowerPrice = positionInfo.priceLower !== undefined ? positionInfo.priceLower : 0;
    const upperPrice = positionInfo.priceUpper !== undefined ? positionInfo.priceUpper : Infinity;

    console.log(`Position price range: $${lowerPrice} - $${upperPrice}`);
    console.log(`Current price: $${currentPrice}`);

    // Check if current price is outside the position range (with some buffer)
    const bufferPercent = 0.05; // 5% buffer
    const isOutOfRange = currentPrice < (lowerPrice * (1 + bufferPercent)) ||
      currentPrice > (upperPrice * (1 - bufferPercent));

    if (isOutOfRange) {
      console.log('⚠️ Position is out of range or near the edge! Needs rebalancing.');
    } else {
      console.log('✓ Position is in range.');
    }

    return isOutOfRange;
  }
}