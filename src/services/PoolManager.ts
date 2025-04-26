import { ethers } from 'ethers';
import { NetworkConfig } from '../utils/types';
import IUniswapV3PoolABI from '../contracts/abis/IUniswapV3Pool.json';
import IUniswapV3FactoryABI from '../contracts/abis/IUniswapV3Factory.json';

/**
 * Service for managing Uniswap V3 pools
 */
export class PoolManager {
  private provider: ethers.providers.JsonRpcProvider;
  private signer: ethers.Wallet;
  private factoryAddress: string;
  private feeTiers: number[];
  private createPoolIfNeeded: boolean;
  private poolFee: number;

  constructor(
    private config: NetworkConfig,
    privateKey: string
  ) {
    this.provider = new ethers.providers.JsonRpcProvider(config.rpcUrl);
    this.signer = new ethers.Wallet(privateKey, this.provider);

    // Initialize factory address and fee tiers    
    this.factoryAddress = config.uniswap.factory;
    this.feeTiers = config.uniswap.feeTiers;
    this.poolFee = config.uniswap.poolFee;
    this.createPoolIfNeeded = config.uniswap.createPoolIfNeeded || false;

    console.log(`
      --------------------------------
      PoolManager initialized with:
      Factory address: ${this.factoryAddress}
      Fee tiers: ${this.feeTiers.join(', ')}
      Default fee tier: ${this.poolFee}
      Create pool if needed: ${this.createPoolIfNeeded}
      --------------------------------
    `);
  }

  /**
   * Gets a pool for a token pair
   * @param token0 First token address
   * @param token1 Second token address
   * @param feeTier Fee tier (default: from config)
   * @returns Pool address or null if pool doesn't exist
   */
  public async getPool(
    token0: string,
    token1: string,
    feeTier: number = this.poolFee
  ): Promise<string | null> {
    // Ensure token order (token0 < token1 in Uniswap V3)
    const [sortedToken0, sortedToken1] = ethers.utils.getAddress(token0) < ethers.utils.getAddress(token1)
      ? [token0, token1]
      : [token1, token0];

    try {
      // Get the factory contract
      const factory = new ethers.Contract(
        this.factoryAddress,
        IUniswapV3FactoryABI,
        this.provider
      );

      // Get the pool address
      const poolAddress = await factory.getPool(sortedToken0, sortedToken1, feeTier);

      // Check if pool exists (address is not zero)
      if (poolAddress === ethers.constants.AddressZero) {
        console.log(`Pool does not exist for token pair ${sortedToken0} - ${sortedToken1} with fee tier ${feeTier}`);
        return null;
      }

      console.log(`Found pool ${poolAddress} for token pair ${sortedToken0} - ${sortedToken1}`);
      return poolAddress;
    } catch (error) {
      console.error(`Error getting pool for token pair ${token0} - ${token1}:`, error);
      return null;
    }
  }

  /**
   * Gets optimal fee tier for a token pair
   * @param token0 First token address
   * @param token1 Second token address
   * @returns The optimal fee tier
   */
  public async getOptimalFeeTier(
    token0: string,
    token1: string
  ): Promise<number> {
    console.log(`Finding optimal fee tier for ${token0} - ${token1}`);

    // Use the default fee tier to start
    let optimalFee = this.poolFee;
    let highestLiquidity = ethers.BigNumber.from(0);

    // Check all fee tiers to find the one with the most liquidity
    for (const feeTier of this.feeTiers) {
      try {
        const poolAddress = await this.getPool(token0, token1, feeTier);

        if (poolAddress) {
          const pool = new ethers.Contract(
            poolAddress,
            IUniswapV3PoolABI,
            this.provider
          );

          const liquidity = await pool.liquidity();
          console.log(`Pool with fee tier ${feeTier} has liquidity: ${liquidity.toString()}`);

          if (liquidity.gt(highestLiquidity)) {
            highestLiquidity = liquidity;
            optimalFee = feeTier;
          }
        }
      } catch (error) {
        console.error(`Error checking fee tier ${feeTier}:`, error);
      }
    }

    console.log(`Optimal fee tier for ${token0} - ${token1} is ${optimalFee}`);
    return optimalFee;
  }
} 