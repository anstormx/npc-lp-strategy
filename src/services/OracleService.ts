import { Contract, ethers, BigNumber } from "ethers";
import {
	PriceData,
	NetworkConfig,
} from "../utils/types";
import IUniswapV3Pool from "../contracts/abis/IUniswapV3Pool.json";

/**
 * Oracle Service that provides on-chain (Uniswap) price data for the strategy
 */
export class OracleService {
	private provider: ethers.providers.JsonRpcProvider;
	private poolContract: Contract;
	private token0: string | null = null;
	private token1: string | null = null;
	private token0Decimals: number | null = null;
	private token1Decimals: number | null = null;
	private poolFee: number | null = null;
	private tickSpacing: number | null = null;

	constructor(private config: NetworkConfig) {
		this.provider = new ethers.providers.JsonRpcProvider(config.rpcUrl);
		this.poolContract = new ethers.Contract(
			config.uniswap.poolAddress,
			IUniswapV3Pool,
			this.provider
		);
		console.log(`
      --------------------------------
      Oracle Service constructor
      --------------------------------
    `);
	}

	/**
	 * Initialize the pool contract
	 * @param poolContract The Uniswap V3 pool contract
	 */
	public async initialize(
		token0Contract: Contract,
		token1Contract: Contract
	): Promise<void> {
		this.token0 = token0Contract.address;
		this.token1 = token1Contract.address;
		this.token0Decimals = await token0Contract.decimals();
		this.token1Decimals = await token1Contract.decimals();
		this.poolFee = await this.poolContract.fee();
		this.tickSpacing = await this.poolContract.tickSpacing();

		console.log(`
      --------------------------------
      Oracle Service initialized:
      Token0: ${this.token0}
      Token1: ${this.token1}
      Token0 decimals: ${this.token0Decimals}
      Token1 decimals: ${this.token1Decimals}
      Fee: ${this.poolFee}
      Tick spacing: ${this.tickSpacing}
      --------------------------------
    `);
	}

	/**
	 * Fetches the price from Uniswap V3 pool
	 * @returns The latest price and current tick from Uniswap
	 */
	public async fetchUniswapPrice(): Promise<{ price: number; tick: number }> {
		try {
			const [sqrtPriceX96, tick] = await this.poolContract.slot0();
			console.log(`Current tick: ${tick}`);

			// Use sqrtPriceX96 for accurate price calculation
			// The formula is: price = (sqrtPriceX96^2 * 10^(token0Decimals - token1Decimals)) / 2^192
			const sqrtPriceX96BN = BigNumber.from(sqrtPriceX96);
			const Q96 = BigNumber.from(2).pow(96);

			// First square the sqrtPrice
			const priceX192 = sqrtPriceX96BN.mul(sqrtPriceX96BN);

			// Adjust for decimal differences between tokens
			const decimalAdjustment = BigNumber.from(10).pow(
				this.token0Decimals! - this.token1Decimals!
			);

			// Calculate price = priceX192 * decimalAdjustment / (2^192)
			const denominator = Q96.mul(Q96);

			// Try to calculate with full precision
			const numerator = priceX192.mul(decimalAdjustment);
			const rawPrice = numerator.div(denominator);
			const price = parseFloat(ethers.utils.formatUnits(rawPrice, 0));

			return { price, tick: Number(tick) };
		} catch (error) {
			throw new Error(`Error fetching Uniswap price: ${error}`);
		}
	}

	/**
	 * Gets the oracle price from Uniswap
	 * @returns The oracle price data with current tick
	 */
	public async getOraclePrice(): Promise<PriceData> {
		try {
			const { price: uniswapPrice, tick } =
				await this.fetchUniswapPrice();

			const priceData: PriceData = {
				uniswapPrice: uniswapPrice,
				timestamp: Math.floor(Date.now() / 1000),
				tick: tick,
			};

      return priceData;
		} catch (error) {
			console.error("Error getting oracle price");
			throw error;
		}
	}

	/**
	 * Returns the current tick spacing value used for this pool
	 * @returns The tick spacing value
	 */
	public getTickSpacing(): number {
		return this.tickSpacing!;
	}
}
