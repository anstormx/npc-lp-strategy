import { Contract, ethers, BigNumber } from 'ethers';
import { NetworkConfig, PositionInfo } from '../utils/types';
import NonfungiblePositionManagerABI from '../contracts/abis/INonfungiblePositionManager.json';
import IERC20ABI from '../contracts/abis/IERC20.json';
import WETHABI from '../contracts/abis/IWETH.json';
import { OracleService } from './OracleService';
import { PoolManager } from './PoolManager';

/**
 * Service for managing Uniswap V3 liquidity positions
 */
export class LiquidityManager {
  private provider: ethers.providers.JsonRpcProvider;
  private signer: ethers.Wallet;
  private positionManager: Contract;
  private walletAddress: string;
  private token0: string;
  private token1: string;
  private token0Contract: Contract;
  private token1Contract: Contract;
  private poolFee: number;

  constructor(
    private config: NetworkConfig,
    privateKey: string
  ) {
    this.provider = new ethers.providers.JsonRpcProvider(config.rpcUrl);
    this.signer = new ethers.Wallet(privateKey, this.provider);
    this.walletAddress = this.signer.address;
    this.poolFee = config.uniswap.poolFee;
    this.positionManager = new ethers.Contract(
      config.uniswap.positionManager,
      NonfungiblePositionManagerABI,
      this.signer
    );

    // Set token addresses - will verify order in initialize()
    this.token0 = config.tokens.WETH;
    this.token1 = config.tokens.USDC;

    // Initialize token contracts
    this.token0Contract = new ethers.Contract(this.token0, WETHABI, this.signer); // maybe IERC20ABI
    this.token1Contract = new ethers.Contract(this.token1, IERC20ABI, this.signer);

    console.log(`
      --------------------------------
      Liquidity Manager initialized:
      Token0: ${this.token0}
      Token1: ${this.token1}
      Pool Fee: ${this.poolFee}
      Position Manager: ${this.positionManager.address}
      --------------------------------
    `);
  }

  /**
   * Approve tokens for the position manager
   * @param token0Amount Amount of token0 to approve
   * @param token1Amount Amount of token1 to approve
   */
  private async approveTokens(
    token0Amount: BigNumber,
    token1Amount: BigNumber
  ): Promise<void> {

    // Approve token0
    const allowance0 = await this.token0Contract.allowance(this.walletAddress, this.positionManager.address);

    if (allowance0.lt(token0Amount)) {
      console.log(`Approving ${this.positionManager.address} to spend token0...`);
      const tx0 = await this.token0Contract.approve(this.positionManager.address, ethers.constants.MaxUint256, {
        gasLimit: 100000 // Set a high enough gas limit to avoid estimation errors
      });
      await tx0.wait();
      console.log('Token0 approved');
    } else {
      console.log('Token0 already has sufficient allowance');
    }

    // Approve token1
    const allowance1 = await this.token1Contract.allowance(this.walletAddress, this.positionManager.address);

    if (allowance1.lt(token1Amount)) {
      console.log(`Approving ${this.positionManager.address} to spend token1...`);
      const tx1 = await this.token1Contract.approve(this.positionManager.address, ethers.constants.MaxUint256, {
        gasLimit: 100000 // Set a high enough gas limit to avoid estimation errors
      });
      await tx1.wait();
      console.log('Token1 approved');
    } else {
      console.log('Token1 already has sufficient allowance');
    }
  }

  /**
   * Creates a new liquidity position
   * @param tickLower Lower tick boundary
   * @param tickUpper Upper tick boundary
   * @param amount0Desired Desired amount of token0
   * @param amount1Desired Desired amount of token1
   * @returns Position ID of the minted position
   */
  public async mintPosition(
    tickLower: number,
    tickUpper: number,
    amount0Desired: BigNumber,
    amount1Desired: BigNumber,
    amount0Min: BigNumber = BigNumber.from(0),
    amount1Min: BigNumber = BigNumber.from(0)
  ): Promise<number> {

    // Tick bounds sanity check
    if (tickLower >= tickUpper) {
      throw new Error('Invalid tick bounds: lower must be < upper');
    }

    // Print position parameters
    console.log(`Minting new position with:
      Tick Range: [${tickLower}, ${tickUpper}]
      Token0 Amount: ${ethers.utils.formatEther(amount0Desired)}
      Token1 Amount: ${ethers.utils.formatUnits(amount1Desired, 6)}
      Mode: MAINNET
    `);

    // Real implementation for mainnet
    try {
      // Approve tokens for position manager
      await this.approveTokens(amount0Desired, amount1Desired);

      // Set deadline to 20 minutes from now (increased from 10 minutes)
      const deadline = Math.floor(Date.now() / 1000) + 1200;

      // Calculate minimum amounts with 2% slippage protection if not specified
      if (amount0Min.isZero()) {
        amount0Min = amount0Desired.mul(98).div(100);
        console.log(`Calculated amount0Min with slippage protection: ${ethers.utils.formatEther(amount0Min)}`);
      }

      if (amount1Min.isZero()) {
        amount1Min = amount1Desired.mul(98).div(100);
        console.log(`Calculated amount1Min with slippage protection: ${ethers.utils.formatUnits(amount1Min, 6)}`);
      }

      // Create the mint params
      const params = {
        token0: this.token0,
        token1: this.token1,
        fee: this.poolFee,
        tickLower,
        tickUpper,
        amount0Desired,
        amount1Desired,
        amount0Min,
        amount1Min,
        recipient: this.walletAddress,
        deadline
      };

      console.log(`Attempting to mint position with params:`, JSON.stringify({
        fee: this.poolFee,
        tickLower,
        tickUpper,
        amount0Desired: ethers.utils.formatEther(amount0Desired),
        amount1Desired: ethers.utils.formatUnits(amount1Desired, 6),
        amount0Min: ethers.utils.formatEther(amount0Min),
        amount1Min: ethers.utils.formatUnits(amount1Min, 6),
        deadline
      }, null, 2));

      const tx = await this.positionManager.mint(params);
      console.log(`Mint transaction hash: ${tx.hash}`);

      // Wait for the transaction to confirm
      const receipt = await tx.wait();

      console.log(`Transaction receipt received. 
        --------------------------------
          ${JSON.stringify(receipt, null, 2)}
        --------------------------------
        `);

      try {
        // More robust event parsing
        let tokenId: number | undefined;

        // Look through raw logs for the Transfer signature and proper contract address
        console.log('Looking through logs for Transfer event...');

        // Transfer event signature
        const transferEventTopic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

        // Find log that matches NFT transfer (from 0x0 address)
        const nftTransferLog = receipt.logs.find((log: any) =>
          log.address.toLowerCase() === this.positionManager.address.toLowerCase() &&
          log.topics[0] === transferEventTopic &&
          log.topics[1] === "0x0000000000000000000000000000000000000000000000000000000000000000"
        );

        console.log(`NFT Transfer log: ${JSON.stringify(nftTransferLog, null, 2)}`);

        if (nftTransferLog && nftTransferLog.topics.length >= 4) {
          // NFT tokenId is in the 4th topic (index 3)
          tokenId = parseInt(nftTransferLog.topics[3], 16);
          console.log(`Found tokenId ${tokenId} from Transfer log (topic index 3)`);
        }

        if (!tokenId) {
          throw new Error('Failed to determine tokenId from transaction receipt');
        }

        console.log(`Position minted with token ID: ${tokenId}`);

        // Check for IncreaseLiquidity event to log actual amounts used
        let amount0Used = BigNumber.from(0);
        let amount1Used = BigNumber.from(0);

        const increaseLiquidityTopic = "0x3067048beee31b25b2f1681f88dac838c8bba36af25bfb2b7cf7473a5847e35f";
        const increaseLiquidityLog = receipt.logs.find((log: any) =>
          log.address.toLowerCase() === this.positionManager.address.toLowerCase() &&
          log.topics[0] === increaseLiquidityTopic
        );

        console.log(`IncreaseLiquidity log: ${JSON.stringify(increaseLiquidityLog, null, 2)}`);

        if (increaseLiquidityLog && increaseLiquidityLog.data.length > 2) {
          // Parse the data field - it contains amounts used
          const decodedData = ethers.utils.defaultAbiCoder.decode(
            ['uint256', 'uint256', 'uint256'],
            increaseLiquidityLog.data
          );
          amount0Used = decodedData[1];
          amount1Used = decodedData[2];
        }


        // Log position stats if we found the amounts
        if (!amount0Used.isZero() || !amount1Used.isZero()) {
          console.log(`
            Position Created Stats:
            - Amount0 Used: ${ethers.utils.formatEther(amount0Used)} WETH
            - Amount1 Used: ${ethers.utils.formatUnits(amount1Used, 6)} USDC
          `);
        }

        return tokenId;
      } catch (error) {
        console.error('Error processing mint transaction:', error);
        throw error;
      }
    } catch (error) {
      console.error('Error minting position:', error);
      throw error;
    }
  }

  /**
   * Decreases liquidity in a position
   * @param tokenId ID of the position token
   * @param liquidity Amount of liquidity to remove (or 0 for all)
   * @returns Amounts of token0 and token1 received
   */
  public async decreaseLiquidity(
    tokenId: number,
    liquidity: BigNumber = BigNumber.from(0),
    amount0Min: BigNumber = BigNumber.from(0),
    amount1Min: BigNumber = BigNumber.from(0)
  ): Promise<{ amount0: BigNumber, amount1: BigNumber }> {
    try {
      // Get position info if liquidity not specified
      if (liquidity.isZero()) {
        const position = await this.getPositionInfo(tokenId);
        liquidity = position.liquidity;
      }

      if (liquidity.isZero()) {
        console.log(`Position ${tokenId} has no liquidity to decrease`);
        return { amount0: BigNumber.from(0), amount1: BigNumber.from(0) };
      }

      // Set deadline to 10 minutes from now
      const deadline = Math.floor(Date.now() / 1000) + 600;

      const params = {
        tokenId,
        liquidity,
        amount0Min,
        amount1Min,
        deadline
      };

      console.log(`Decreasing liquidity for position ${tokenId} by ${liquidity.toString()}`);

      // Decrease liquidity
      const tx = await this.positionManager.decreaseLiquidity(params);
      console.log(`Decrease liquidity transaction hash: ${tx.hash}`);

      // Wait for the transaction to confirm
      const receipt = await tx.wait();

      console.log(`Decrease liquidity receipt: 
        --------------------------------
          ${JSON.stringify(receipt, null, 2)}
        --------------------------------
        `);

      // DecreaseLiquidity event signature: 0x26f6a048ee9138f2c0ce266f322cb99228e8d619ae2bff30c67f8dcf9d2377b4
      const decreaseLiquidityLog = receipt.logs?.find((log: any) =>
        log.topics[0] === '0x26f6a048ee9138f2c0ce266f322cb99228e8d619ae2bff30c67f8dcf9d2377b4' &&
        log.address.toLowerCase() === this.positionManager.address.toLowerCase()
      );

      // Decode the data field - format is (uint128 liquidity, uint256 amount0, uint256 amount1)
      const decodedData = ethers.utils.defaultAbiCoder.decode(
        ['uint128', 'uint256', 'uint256'],
        decreaseLiquidityLog.data
      );

      const amount0 = decodedData[1];
      const amount1 = decodedData[2];

      console.log(`Liquidity decreased. Received: 
        Token0: ${ethers.utils.formatEther(amount0)} WETH
        Token1: ${ethers.utils.formatUnits(amount1, 6)} USDC
      `);

      return { amount0, amount1 };
    } catch (error) {
      console.error('Error decreasing liquidity:', error);
      throw error;
    }
  }

  /**
   * Collects fees from a position
   * @param tokenId ID of the position token
   * @returns Amounts of token0 and token1 collected as fees
   */
  public async collectFees(
    tokenId: number
  ): Promise<{ amount0: BigNumber, amount1: BigNumber }> {
    try {

      const MAX_UINT128 = BigNumber.from("0xffffffffffffffffffffffffffffffff"); // 2^128 - 1

      const params = {
        tokenId,
        recipient: this.walletAddress,
        amount0Max: MAX_UINT128,
        amount1Max: MAX_UINT128
      };

      console.log(`Collecting fees for position ${tokenId}`);

      // Collect fees
      const tx = await this.positionManager.collect(params);
      console.log(`Collect fees transaction hash: ${tx.hash}`);

      // Wait for the transaction to confirm
      const receipt = await tx.wait();


      console.log(`Collect fees receipt: 
        --------------------------------
          ${JSON.stringify(receipt, null, 2)}
        --------------------------------
        `);

      // The Collect event signature from the logs: 0x40d0efd1a53d60ecbf40971b9daf7dc90178c3aadc7aab1765632738fa8b8f01
      const collectLog = receipt.logs?.find((log: any) =>
        log.topics[0] === '0x40d0efd1a53d60ecbf40971b9daf7dc90178c3aadc7aab1765632738fa8b8f01' &&
        log.address.toLowerCase() === this.positionManager.address.toLowerCase()
      );

      const decodedData = ethers.utils.defaultAbiCoder.decode(
        ['address', 'uint256', 'uint256'],
        collectLog?.data || '0x'
      );

      const amount0 = decodedData[1];
      const amount1 = decodedData[2];

      return { amount0, amount1 };
    } catch (error) {
      console.error('Error collecting fees:', error);
      throw error;
    }
  }

  /**
   * Burns a position NFT after it has no liquidity
   * @param tokenId ID of the position token
   */
  public async burnPosition(tokenId: number): Promise<void> {
    try {
      console.log(`Burning position ${tokenId}`);

      // Burn the position NFT
      const tx = await this.positionManager.burn(tokenId);
      console.log(`Burn transaction hash: ${tx.hash}`);

      // Wait for the transaction to confirm
      await tx.wait();

      console.log(`Position ${tokenId} burned`);
    } catch (error) {
      console.error('Error burning position:', error);
      throw error;
    }
  }

  /**
   * Gets information about a position
   * @param tokenId ID of the position token
   * @returns Position information
   */
  public async getPositionInfo(tokenId: number): Promise<PositionInfo> {

    try {
      // Get position data from contract
      const position = await this.positionManager.positions(tokenId);

      // Calculate the price boundaries
      const priceLower = this.tickToPrice(position.tickLower);
      const priceUpper = this.tickToPrice(position.tickUpper);

      // Check if the position is in range
      const currentTick = await this.getCurrentTick(); // You'll need to implement this method
      const inRange = position.tickLower <= currentTick && currentTick <= position.tickUpper;

      // Get detailed info about this position
      return {
        tickLower: position.tickLower,
        tickUpper: position.tickUpper,
        liquidity: position.liquidity,
        amount0: BigNumber.from(0), // Will be calculated later
        amount1: BigNumber.from(0), // Will be calculated later
        inRange,
        tokenId,
        token0Amount: BigNumber.from(0), // Note: not included in the positions() call
        token1Amount: BigNumber.from(0), // Note: not included in the positions() call
        feeGrowthInside0LastX128: position.feeGrowthInside0LastX128,
        feeGrowthInside1LastX128: position.feeGrowthInside1LastX128,
        priceLower,
        priceUpper,
        isActive: !position.liquidity.isZero()
      };
    } catch (error) {
      console.error(`Error getting position info for token ${tokenId}:`, error);
      throw error;
    }
  }

  /**
   * Gets the current tick from the pool
   * @returns The current tick
   */
  private async getCurrentTick(): Promise<number> {
    try {
      // We need to create a pool contract to get the current tick
      if (!this.token0 || !this.token1) {
        console.error('Token addresses not set');
        return 0;
      }

      // Get the pool address from the factory
      const factoryAddress = await this.positionManager.factory();
      const factoryContract = new ethers.Contract(
        factoryAddress,
        [
          'function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)'
        ],
        this.provider
      );

      // Get the pool address
      const poolAddress = await factoryContract.getPool(this.token0, this.token1, this.poolFee);

      if (poolAddress === ethers.constants.AddressZero) {
        console.error('Pool does not exist');
        return 0;
      }

      // Create the pool contract
      const poolContract = new ethers.Contract(
        poolAddress,
        [
          'function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)'
        ],
        this.provider
      );

      // Call slot0 to get the current tick
      const [, tick] = await poolContract.slot0();

      console.log(`Current tick from pool: ${tick}`);
      return Number(tick);
    } catch (error) {
      console.error('Error getting current tick:', error);
      return 0;
    }
  }

  /**
   * Closes a position entirely and burns the NFT
   * @param tokenId ID of the position token
   * @returns Amounts of token0 and token1 received
   */
  public async closePosition(
    tokenId: number
  ): Promise<{ amount0: BigNumber, amount1: BigNumber }> {

    try {
      // First get position info to know how much liquidity to remove
      const position = await this.getPositionInfo(tokenId);

      // Remove all liquidity
      const { amount0, amount1 } = await this.decreaseLiquidity(
        tokenId,
        position.liquidity,
        BigNumber.from(0), // min amount 0
        BigNumber.from(0)  // min amount 1
      );

      // Collect any fees
      const fees = await this.collectFees(tokenId);

      // Burn the position NFT
      await this.burnPosition(tokenId);

      // Add up the liquidity amounts and fees
      const totalAmount0 = amount0.add(fees.amount0);
      const totalAmount1 = amount1.add(fees.amount1);

      console.log(`Position closed successfully`);
      console.log(`Received: ${ethers.utils.formatEther(totalAmount0)} token0 and ${ethers.utils.formatUnits(totalAmount1, 6)} token1`);

      return {
        amount0: totalAmount0,
        amount1: totalAmount1
      };
    } catch (error) {
      console.error('Error closing position:', error);
      throw error;
    }
  }

  /**
   * Calculates optimal amounts for a balanced position
   * @param centerPrice The price to center the position around
   * @param totalValueInToken1 The total value to allocate (in token1 units)
   * @returns The optimal amounts of token0 and token1
   */
  public calculateOptimalAmounts(
    centerPrice: number,
    totalValueInToken1: BigNumber,
    tickLower: number,
    tickUpper: number
  ): { amount0: BigNumber, amount1: BigNumber } {
    // Convert ticks to prices
    const priceLower = Math.pow(1.0001, tickLower);
    const priceUpper = Math.pow(1.0001, tickUpper);

    // Calculate the liquidity value L based on total value and price range
    // This is a simplification - full math involves square roots
    const sqrtPriceLower = Math.sqrt(priceLower);
    const sqrtPriceUpper = Math.sqrt(priceUpper);
    const sqrtPrice = Math.sqrt(centerPrice);

    // Calculate token allocations
    // This mimics Uniswap's formula for calculating amounts from liquidity
    // L = amount1 / (sqrt(P) - sqrt(Pl))
    // L = amount0 * sqrt(Pu) * sqrt(Pl) / (sqrt(Pu) - sqrt(Pl))

    // Simplified allocation for a balanced position
    // This approximation works reasonably well for most cases
    const ratio = (sqrtPrice - sqrtPriceLower) / (sqrtPriceUpper - sqrtPrice);

    // Split the total value according to the ratio
    const token1Value = totalValueInToken1.mul(BigNumber.from(Math.floor(ratio * 100)))
      .div(BigNumber.from(100 + Math.floor(ratio * 100)));
    const token0Value = totalValueInToken1.sub(token1Value);

    // Convert token0 value (in token1 units) to token0 amount
    const amount0 = token0Value.mul(BigNumber.from(10).pow(18))
      .div(BigNumber.from(Math.floor(centerPrice * 1e6)))
      .mul(BigNumber.from(10).pow(6)); // Adjust for decimals

    // Token1 amount is just the value (assuming 6 decimals for USDC)
    const amount1 = token1Value;

    return { amount0, amount1 };
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
} 