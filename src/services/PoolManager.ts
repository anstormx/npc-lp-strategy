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
  private poolFee: number;

  constructor(
    private config: NetworkConfig,
    privateKey: string
  ) {
    this.provider = new ethers.providers.JsonRpcProvider(config.rpcUrl);
    this.signer = new ethers.Wallet(privateKey, this.provider);

    // Initialize factory address and default fee tier    
    this.factoryAddress = config.uniswap.factory;
    // Set default fee to 3000 (0.3%)
    this.poolFee = 3000;

    console.log(`
      --------------------------------
      PoolManager initialized with:
      Factory address: ${this.factoryAddress}
      Default fee tier: ${this.poolFee}
      --------------------------------
    `);
  }

  /**
   * Gets a pool for a token pair
   * @param token0 First token address
   * @param token1 Second token address
   * @param feeTier Fee tier (default: from instance variable)
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
   * Get the current pool fee
   * @returns The pool fee as a number
   */
  public getPoolFee(): number {
    return this.poolFee;
  }

  /**
   * Sets the pool fee
   * @param fee New fee value
   */
  public setPoolFee(fee: number): void {
    if (fee !== this.poolFee) {
      console.log(`Updating pool fee: ${this.poolFee} -> ${fee}`);
      this.poolFee = fee;
    }
  }

  /**
   * Fetches the pool fee directly from a pool contract
   * @param poolAddress Address of the Uniswap V3 pool
   * @returns The fee as a number
   */
  public async fetchPoolFee(poolAddress: string): Promise<number> {
    try {
      // Create the pool contract
      const poolContract = new ethers.Contract(
        poolAddress,
        IUniswapV3PoolABI,
        this.provider
      );
      
      // Fetch the fee from the pool
      const fee = await poolContract.fee();
      console.log(`Fetched pool fee from contract: ${fee}`);
      
      // Update the instance variable
      this.setPoolFee(fee);
      
      return fee;
    } catch (error) {
      console.error(`Error fetching pool fee from ${poolAddress}:`, error);
      throw error;
    }
  }
} 