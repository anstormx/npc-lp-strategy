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

	constructor(private config: NetworkConfig, provider: ethers.providers.JsonRpcProvider) {
		this.provider = provider;
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
	 * Initialize the oracle service with token contracts
	 * @param token0Contract The contract for the first token in the pool
	 * @param token1Contract The contract for the second token in the pool
	 */
	public async initialize(
		token0Contract: Contract,
		token1Contract: Contract
	): Promise<void> {
		this.token0 = token0Contract.address;
		this.token1 = token1Contract.address;
		
		const [
			token0Decimals,
			token1Decimals,
			poolFee,
			tickSpacing
		] = await Promise.all([
			token0Contract.decimals(),
			token1Contract.decimals(),
			this.poolContract.fee(),
			this.poolContract.tickSpacing()
		]);
		
		this.token0Decimals = token0Decimals;
		this.token1Decimals = token1Decimals;
		this.poolFee = poolFee;
		this.tickSpacing = tickSpacing;

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
			const [, tick] = await this.poolContract.slot0();
			console.log(`Current tick: ${tick}`);

			const decimalsDiff = this.token0Decimals! - this.token1Decimals!;
			const tickBasedPrice = Math.pow(1.0001, Number(tick)) * Math.pow(10, decimalsDiff);
			
			console.log(`Price from tick: ${tickBasedPrice}`);
			
			return { price: tickBasedPrice, tick };
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
