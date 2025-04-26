import axios from 'axios';
import { Contract, ethers, BigNumber } from 'ethers';
import { PriceData, NetworkConfig, StrategyStep, PositionRangeParams, PoolCreationParams } from '../utils/types';
import IUniswapV3Pool from '@uniswap/v3-core/artifacts/contracts/interfaces/IUniswapV3Pool.sol/IUniswapV3Pool.json';
import IUniswapV3FactoryABI from '../contracts/abis/IUniswapV3Factory.json';
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
    private privateKey?: string
  ) {
    this.provider = new ethers.providers.JsonRpcProvider(config.rpcUrl, {
      chainId: config.chainId,
      name: 'base'
    });
    this.token0 = config.tokens.ETH;
    this.token1 = config.tokens.USDC;
    this.poolFee = config.uniswap.poolFee;
    
    // Initialize the pool manager if private key is provided
    if (privateKey) {
      this.poolManager = new PoolManager(config, privateKey);
    }
    
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
      Oracle Service initialized:
      Token0: ${this.token0}
      Token1: ${this.token1}
      Fee: ${this.poolFee}
      Tick spacing: ${this.tickSpacing}
      Pool address: ${this.poolAddress}
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
    this.poolFee = Number(await this.poolContract.fee());
    
    // Set appropriate tick spacing
    try {
      this.tickSpacing = await this.poolContract.tickSpacing();
      console.log(`Tick spacing fetched from contract: ${this.tickSpacing}`);
    } catch (error) {
      throw new Error('Failed to fetch tick spacing from contract');
    }

    console.log("--------------------------------");
    console.log(`PoolManager: ${this.poolManager}`);
    console.log(`Oracle initialized with pool: ${this.poolAddress}`);
    console.log(`Token0: ${this.token0}`);
    console.log(`Token1: ${this.token1}`);
    console.log(`Fee: ${this.poolFee}`);
    console.log(`Tick spacing: ${this.tickSpacing}`);
    console.log("--------------------------------");
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
      
      // Use ethers.js formatting to preserve precision
      let price: number;
      
      try {
        // Try to calculate with full precision
        const numerator = priceX192.mul(decimalAdjustment);
        const rawPrice = numerator.div(denominator);
        price = parseFloat(ethers.utils.formatUnits(rawPrice, 0));
      } catch (err) {
        console.warn("Precision error in price calculation, falling back to tick-based price");
        // Fallback to tick-based calculation if we have precision issues
        price = this.tickToPrice(Number(tick), token0Decimals, token1Decimals);
      }
      
      // Verify if the pool is ETH/USDC or USDC/ETH and adjust the price accordingly
      const token0IsETH = this.token0?.toLowerCase() === this.config.tokens.ETH?.toLowerCase();
      if (token0IsETH) {
        // If token0 is ETH and token1 is USDC, we need to invert the price to get ETH/USDC
        console.log(`Token0 is ETH, inverting price from ${price} to ${1/price}`);
        price = 1 / price;
      }
  
      // Sanity check, but don't override
      if (price > 10000 || price < 0.01) {
        // Instead of a warning, actually use a safer fallback
        console.warn(`Calculated price ${price} is outside reasonable range (0.01-10000)`);
        
        // If we have a tick, use tick-based price as fallback
        if (tick) {
          const fallbackPrice = this.tickToPrice(Number(tick), token0Decimals, token1Decimals);
          if (token0IsETH) {
            price = 1 / fallbackPrice;
          } else {
            price = fallbackPrice;
          }
          console.log(`Using tick-based fallback price: ${price}`);
        }
        
        // Final sanity check - if still unreasonable, use a default
        if (price > 10000 || price < 0.01) {
          console.warn(`Fallback price still unreasonable, using default of 1500`);
          price = 1500;
        }
      }
  
      return { price, tick: Number(tick) };
    } catch (error) {
      console.error('Error fetching Uniswap price:', error);
      throw new Error('Error fetching Uniswap price');
    }
  }

  /**
   * Gets the oracle price from Uniswap
   * @returns The oracle price data
   */
  public async getOraclePrice(): Promise<PriceData> {
    try {
      const { price: uniswapPrice } = await this.fetchUniswapPrice();
      
      const priceData: PriceData = {
        uniswapPrice: uniswapPrice,
        timestamp: Math.floor(Date.now() / 1000)
      };

      this.lastPriceData = priceData;
      return priceData;
    } catch (error) {
      console.error('Error getting oracle price:', error);
      
      // If we have last price data, return it as a fallback
      if (this.lastPriceData) {
        console.warn('Using last known price as fallback');
        return this.lastPriceData;
      }
      
      // No fallback available, return a default price
      console.warn('No price data available, using default ETH price of 1500 USD');
      const defaultPrice: PriceData = {
        uniswapPrice: 1500,
        timestamp: Math.floor(Date.now() / 1000)
      };
      
      this.lastPriceData = defaultPrice;
      return defaultPrice;
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
    const positionStep = this.config.strategy.positionStep;
    
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
    const maxTickDeviation = this.config.strategy.maxTickDeviation;
    
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