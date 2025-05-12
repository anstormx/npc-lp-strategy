import axios from 'axios';
import { Contract, ethers, BigNumber } from 'ethers';
import { PriceData, NetworkConfig, StrategyStep, PositionRangeParams } from '../utils/types';
import IUniswapV3Pool from '../contracts/abis/IUniswapV3Pool.json';
import { PoolManager } from './PoolManager';

/**
 * Oracle Service that provides on-chain (Uniswap) price data for the strategy
 */
export class OracleService {
  private provider: ethers.providers.JsonRpcProvider;
  private poolContract: Contract | null = null;
  private poolAddress: string | null = null;
  private token0: string;
  private token1: string;
  private lastPriceData: PriceData | null = null;
  private poolFee: number;
  private tickSpacing: number = 60; // Default for 0.3% pool
  private poolManager: PoolManager | null = null;

  constructor(
    private config: NetworkConfig,
    private privateKey: string,
    private PoolManager: PoolManager
  ) {
    this.provider = new ethers.providers.JsonRpcProvider(config.rpcUrl, {
      chainId: config.chainId,
      name: 'base'
    });
    this.token0 = config.tokens.WETH;
    this.token1 = config.tokens.USDC;
    // Use default fee value of 3000 (0.3%) instead of accessing config
    this.poolFee = 3000;
    this.poolManager = PoolManager;    
    
    // Set default tick spacing based on pool fee (will be updated from contract when initialized)
    if (this.poolFee === 500) {
      this.tickSpacing = 10; // 0.05% pool
    } else if (this.poolFee === 3000) {
      this.tickSpacing = 60; // 0.3% pool
    } else if (this.poolFee === 10000) {
      this.tickSpacing = 200; // 1% pool
    }

    console.log(`
      --------------------------------
      Oracle Service constructor:
      Token0: ${this.token0}
      Token1: ${this.token1}
      Default Fee: ${this.poolFee}
      Default Tick spacing: ${this.tickSpacing}
      --------------------------------
    `);
  }

  /**
   * Initialize the pool contract
   * @param poolContract The Uniswap V3 pool contract
   */
  public async initialize(poolContract: Contract): Promise<void> {
    this.poolContract = poolContract;
    this.poolAddress = poolContract.address;

    this.token0 = await this.poolContract.token0();
    this.token1 = await this.poolContract.token1();
    
    // Get fee and update tickSpacing
    await this.fetchPoolFeeFromContract();
    
    // Set appropriate tick spacing
    try {
      this.tickSpacing = await this.poolContract.tickSpacing();
      console.log(`Tick spacing fetched from contract: ${this.tickSpacing}`);
    } catch (error) {
      // If tickSpacing method not available, set based on fee
      this.updateTickSpacingFromFee();
      console.log(`Using tick spacing calculated from fee: ${this.tickSpacing}`);
    }

    console.log(`
      --------------------------------
      Oracle Service initialized:
      Token0: ${this.token0}
      Token1: ${this.token1}
      Fee: ${this.poolFee}
      Tick spacing: ${this.tickSpacing}
      --------------------------------
    `);
  }

  /**
   * Fetch pool fee from the currently set pool contract
   */
  private async fetchPoolFeeFromContract(): Promise<void> {
    if (!this.poolContract) {
      throw new Error('Pool contract not initialized');
    }
    
    try {
      const fee = await this.poolContract.fee();
      
      if (this.poolFee !== fee) {
        console.log(`Updating pool fee: ${this.poolFee} -> ${fee}`);
        this.poolFee = fee;
      }
    } catch (error) {
      console.error('Error fetching fee from pool contract:', error);
      throw error;
    }
  }

  /**
   * Get the current pool fee
   * @returns The fee as a number
   */
  public getPoolFee(): number {
    return this.poolFee;
  }

  /**
   * Set pool fee and update related values
   * @param fee New fee value
   */
  public setPoolFee(fee: number): void {
    if (fee !== this.poolFee) {
      console.log(`Setting pool fee: ${this.poolFee} -> ${fee}`);
      this.poolFee = fee;
      
      // Update tick spacing when fee changes
      this.updateTickSpacingFromFee();
    }
  }

  /**
   * Fetches pool fee from a specific pool address
   * @param poolAddress The address of the pool to fetch fee from
   * @returns The pool fee
   */
  public async fetchPoolFee(poolAddress: string): Promise<number> {
    try {
      // Create temporary pool contract if needed
      const poolContract = this.poolAddress === poolAddress && this.poolContract 
        ? this.poolContract
        : new ethers.Contract(poolAddress, IUniswapV3Pool, this.provider);
        
      // Fetch the fee
      const fee = await poolContract.fee();
      console.log(`Fetched pool fee from ${poolAddress}: ${fee}`);
      
      // Update our internal fee value
      this.setPoolFee(fee);
      
      return fee;
    } catch (error) {
      console.error(`Error fetching pool fee from ${poolAddress}:`, error);
      throw error;
    }
  }

  /**
   * Update tick spacing based on current fee
   */
  private updateTickSpacingFromFee(): void {
    // Determine tick spacing based on pool fee
    if (this.poolFee === 500) {
      this.tickSpacing = 10; // 0.05% pool
    } else if (this.poolFee === 3000) {
      this.tickSpacing = 60; // 0.3% pool
    } else if (this.poolFee === 10000) {
      this.tickSpacing = 200; // 1% pool
    } else {
      console.warn(`Unknown fee tier: ${this.poolFee}, using default tick spacing of 60`);
      this.tickSpacing = 60;
    }
    console.log(`Updated tick spacing to ${this.tickSpacing} based on fee ${this.poolFee}`);
  }

  /**
   * Fetches the price from Uniswap V3 pool
   * @returns The latest price and current tick from Uniswap
   */
  public async fetchUniswapPrice(): Promise<{ price: number, tick: number }> {
    if (!this.poolContract) {
      throw new Error('Pool contract not initialized');
    }

    try {
      const [sqrtPriceX96, tick] = await this.poolContract.slot0();
      console.log(`Current tick: ${tick}`);

      const token0Decimals = 18; // WETH
      const token1Decimals = 6;  // USDC
  
      // Use sqrtPriceX96 for accurate price calculation
      // The formula is: price = (sqrtPriceX96^2 * 10^(token0Decimals - token1Decimals)) / 2^192
      const sqrtPriceX96BN = BigNumber.from(sqrtPriceX96);
      const Q96 = BigNumber.from(2).pow(96);
  
      // First square the sqrtPrice
      const priceX192 = sqrtPriceX96BN.mul(sqrtPriceX96BN);
      
      // Adjust for decimal differences between tokens
      const decimalAdjustment = BigNumber.from(10).pow(token0Decimals - token1Decimals);
      
      // Calculate price = priceX192 * decimalAdjustment / (2^192)
      const denominator = Q96.mul(Q96);
      
      let price: number;
      
      // Try to calculate with full precision
      const numerator = priceX192.mul(decimalAdjustment);
      const rawPrice = numerator.div(denominator);
      price = parseFloat(ethers.utils.formatUnits(rawPrice, 0));
  
      return { price, tick: Number(tick) };
    } catch (error) {
      throw new Error( `Error fetching Uniswap price: ${error}`);
    }
  }

  /**
   * Gets the oracle price from Uniswap
   * @returns The oracle price data with current tick
   */
  public async getOraclePrice(): Promise<PriceData> {
    try {
      const { price: uniswapPrice, tick } = await this.fetchUniswapPrice();
      
      const priceData: PriceData = {
        uniswapPrice: uniswapPrice,
        timestamp: Math.floor(Date.now() / 1000),
        tick: tick
      };

      this.lastPriceData = priceData;
      return priceData;
    } catch (error) {
      throw new Error();
    }
  }

  /**
   * Determines if the current price is outside the specified tick range
   * @param tickLower The lower tick boundary
   * @param tickUpper The upper tick boundary
   * @returns Whether the position needs rebalancing
   */
  public async isOutOfRange(tickLower: number, tickUpper: number): Promise<boolean> {
    if (!this.poolContract) {
      throw new Error('Pool contract not initialized');
    }

    // Get the current price
    const [, currentTick, , , , ,] = await this.poolContract.slot0();
    
    // Check if current tick is outside the range
    return currentTick <= tickLower || currentTick >= tickUpper;
  }

  /**
   * Converts tick to price with decimal adjustment
   * @param tick The tick to convert
   * @param token0Decimals Decimals of token0
   * @param token1Decimals Decimals of token1
   * @returns The price at the given tick
   */
  public tickToPrice(tick: number, token0Decimals = 18, token1Decimals = 6): number {
    // Base formula: price = 1.0001^tick
    // For better precision with extreme values, split the calculation
    
    // Avoid Math.pow precision issues with large ticks
    let price: number;
    
    if (Math.abs(tick) > 50000) {
      // For very large ticks, break into smaller steps
      const sign = Math.sign(tick);
      const remainder = Math.abs(tick) % 50000;
      const iterations = Math.floor(Math.abs(tick) / 50000);
      
      // Calculate price in steps
      price = 1.0;
      const step = Math.pow(1.0001, 50000 * sign);
      for (let i = 0; i < iterations; i++) {
        price *= step;
      }
      
      // Apply remainder
      price *= Math.pow(1.0001, remainder * sign);
    } else {
      // For reasonable tick values, calculate directly
      price = Math.pow(1.0001, tick);
    }
    
    // Apply decimal adjustment
    if (token0Decimals !== token1Decimals) {
      price *= Math.pow(10, token0Decimals - token1Decimals);
    }
    
    return price;
  }
  
  /**
   * Converts price to the nearest valid tick
   * @param price The price to convert
   * @returns The nearest tick for the given price
   */
  public priceToTick(price: number): number {
    // ln(price) / ln(1.0001)
    const tick = Math.floor(Math.log(price) / Math.log(1.0001));
    // Round to the nearest tick spacing
    return Math.floor(tick / this.tickSpacing) * this.tickSpacing;
  }

  /**
   * Calculates the tick range based on NPC LP strategy
   * @param step Current strategy step
   * @returns Position range parameters
   */
  public async calculateNpcStrategyRange(step: StrategyStep): Promise<PositionRangeParams> {
    const { tick: currentTick, price: currentPrice } = await this.fetchUniswapPrice();
    // Use a default position step of 1 instead of accessing a non-existent property
    const positionStep = 1; // Default to 1 tick spacing unit
    
    let tickLower: number;
    let tickUpper: number;
    
    // Adjust ticks based on current step
    if (step === StrategyStep.TOKEN0_TO_TOKEN1) {
      // ETH to USDC (Step 1): Place LP above current price
      tickLower = currentTick + (this.tickSpacing * positionStep);
      tickUpper = currentTick + (this.tickSpacing * (positionStep + 2));
    } else {
      // USDC to ETH (Step 2): Place LP below current price
      tickLower = currentTick - (this.tickSpacing * (positionStep + 2));
      tickUpper = currentTick - (this.tickSpacing * positionStep);
    }
    
    // Ensure ticks are aligned with spacing
    tickLower = Math.floor(tickLower / this.tickSpacing) * this.tickSpacing;
    tickUpper = Math.floor(tickUpper / this.tickSpacing) * this.tickSpacing;
    
    // Convert ticks to prices
    const priceLower = this.tickToPrice(tickLower);
    const priceUpper = this.tickToPrice(tickUpper);
    
    return {
      tickLower,
      tickUpper,
      priceLower,
      priceUpper,
      currentTick,
      currentPrice
    };
  }

  /**
   * Determines if rebalancing is needed based on price movement
   * @param tickLower Lower tick boundary
   * @param tickUpper Upper tick boundary
   * @param step Current strategy step
   * @returns Whether rebalancing is needed and rebalance type
   */
  public async checkRebalanceNeeded(
    tickLower: number, 
    tickUpper: number, 
    step: StrategyStep
  ): Promise<{ needed: boolean, closePosition: boolean, nextStep: StrategyStep | null }> {
    if (!this.poolContract) {
      throw new Error('Pool contract not initialized');
    }
    
    const [, currentTick, , , , ,] = await this.poolContract.slot0();
    // Use a default maxTickDeviation of 2 tick spacing units
    const maxTickDeviation = this.tickSpacing * 2; // Default to 2 tick spacing units
    
    // Check if out of range (basic check)
    const outOfRange = currentTick <= tickLower || currentTick >= tickUpper;
    
    // Step 1: ETH to USDC
    if (step === StrategyStep.TOKEN0_TO_TOKEN1) {
      // If price goes up enough to cross upper bound, close position and move to step 2
      if (currentTick >= tickUpper) {
        return { needed: true, closePosition: true, nextStep: StrategyStep.TOKEN1_TO_TOKEN0 };
      }
      // If price goes down significantly, rebalance but stay in step 1
      else if (currentTick < tickLower - maxTickDeviation) {
        return { needed: true, closePosition: true, nextStep: null };
      }
      // If slightly out of range but not enough to trigger major rebalance
      else if (outOfRange) {
        return { needed: true, closePosition: false, nextStep: null };
      }
    } 
    // Step 2: USDC to ETH
    else {
      // If price goes down enough to cross lower bound, close position and move to step 1
      if (currentTick <= tickLower) {
        return { needed: true, closePosition: true, nextStep: StrategyStep.TOKEN0_TO_TOKEN1 };
      }
      // If price goes up significantly, rebalance but stay in step 2
      else if (currentTick > tickUpper + maxTickDeviation) {
        return { needed: true, closePosition: true, nextStep: null };
      }
      // If slightly out of range but not enough to trigger major rebalance
      else if (outOfRange) {
        return { needed: true, closePosition: false, nextStep: null };
      }
    }
    
    // No rebalance needed
    return { needed: false, closePosition: false, nextStep: null };
  }

  /**
   * Calculates the tick range for a position centered around the current price
   * @param centerPrice The price to center the range around
   * @param widthPercent The width of the range as a percentage
   * @returns The lower and upper ticks for the range
   */
  public calculateTickRange(centerPrice: number, widthPercent: number = 10): { tickLower: number, tickUpper: number } {
    // Calculate half width as a multiplier
    const halfWidthMultiplier = 1 + (widthPercent / 100) / 2;
    
    // Calculate price range
    const lowerPrice = centerPrice / halfWidthMultiplier;
    const upperPrice = centerPrice * halfWidthMultiplier;
    
    // Convert to ticks and adjust for tick spacing
    const rawTickLower = Math.floor(Math.log(lowerPrice) / Math.log(1.0001));
    const rawTickUpper = Math.floor(Math.log(upperPrice) / Math.log(1.0001));
    
    const tickLower = Math.floor(rawTickLower / this.tickSpacing) * this.tickSpacing;
    const tickUpper = Math.floor(rawTickUpper / this.tickSpacing) * this.tickSpacing;
    
    return { tickLower, tickUpper };
  }

  /**
   * Returns the current tick spacing value used for this pool
   * @returns The tick spacing value
   */
  public getTickSpacing(): number {
    return this.tickSpacing;
  }

  /**
   * Validates and adjusts tick ranges for single-sided liquidity positions
   * @param tickLower Lower tick boundary
   * @param tickUpper Upper tick boundary
   * @param isToken0Only True if only token0 (WETH) is being provided
   * @param isToken1Only True if only token1 (USDC) is being provided
   * @returns Adjusted tick boundaries that ensure out-of-range positioning
   */
  public async validateSingleSidedPosition(
    tickLower: number,
    tickUpper: number,
    isToken0Only: boolean,
    isToken1Only: boolean
  ): Promise<{ tickLower: number, tickUpper: number }> {
    // If not a single-sided position, no adjustment needed
    if (!isToken0Only && !isToken1Only) {
      return { tickLower, tickUpper };
    }

    // Get current tick from the pool
    const { tick: currentTick } = await this.getCurrentTickAndPrice();
    console.log(`Validating single-sided position: Current tick ${currentTick}, Range [${tickLower}, ${tickUpper}]`);
    
    // For token0-only positions (e.g., WETH only), the position must be entirely ABOVE the current price
    if (isToken0Only) {
      // Check if current price is at or above the lower bound
      if (currentTick >= tickLower) {
        // Need to adjust the range to be safely above current price
        // Use a minimal safety buffer to stay close to the current price
        const safetyBuffer = this.tickSpacing; // Reduced from tickSpacing * 2
        
        // Set lower tick just above current tick with minimal buffer
        const newLower = Math.ceil((currentTick + safetyBuffer) / this.tickSpacing) * this.tickSpacing;
        
        // Keep the same range width as originally intended
        const rangeWidth = tickUpper - tickLower;
        const newUpper = newLower + rangeWidth;
        
        console.log(`WETH-only position: Adjusting range to be just above current price: [${tickLower}, ${tickUpper}] → [${newLower}, ${newUpper}]`);
        return { tickLower: newLower, tickUpper: newUpper };
      }
    }
    
    // For token1-only positions (e.g., USDC only), the position must be entirely BELOW the current price
    if (isToken1Only) {
      // Check if current price is at or below the upper bound
      if (currentTick <= tickUpper) {
        // Need to adjust the range to be safely below current price
        // Use a minimal safety buffer to stay close to the current price
        const safetyBuffer = this.tickSpacing; // Reduced from tickSpacing * 2
        
        // Set upper tick just below current tick with minimal buffer
        const newUpper = Math.floor((currentTick - safetyBuffer) / this.tickSpacing) * this.tickSpacing;
        
        // Keep the same range width as originally intended
        const rangeWidth = tickUpper - tickLower;
        const newLower = newUpper - rangeWidth;
        
        console.log(`USDC-only position: Adjusting range to be just below current price: [${tickLower}, ${tickUpper}] → [${newLower}, ${newUpper}]`);
        return { tickLower: newLower, tickUpper: newUpper };
      }
    }
    
    // Position is already correctly positioned
    console.log(`Single-sided position already correctly positioned: [${tickLower}, ${tickUpper}]`);
    return { tickLower, tickUpper };
  }

  /**
   * Gets the current pool tick and price
   * @returns Current tick and price
   */
  public async getCurrentTickAndPrice(): Promise<{ tick: number, price: number }> {
    if (!this.poolContract) {
      throw new Error('Pool contract not initialized');
    }
    
    try {
      return await this.fetchUniswapPrice();
    } catch (error) {
      console.error('Error getting current tick and price:', error);
      
      // Fallback to direct slot0 call with simplified price calculation
      const [, tick] = await this.poolContract.slot0();
      const tickNumber = Number(tick);
      const price = this.tickToPrice(tickNumber);
      
      return { tick: tickNumber, price };
    }
  }
} 