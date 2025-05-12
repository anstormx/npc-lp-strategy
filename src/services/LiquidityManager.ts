import { Contract, ethers, BigNumber } from "ethers";
import { NetworkConfig, PositionInfo } from "../utils/types";
import NonfungiblePositionManagerABI from "../contracts/abis/INonfungiblePositionManager.json";
import IERC20ABI from "../contracts/abis/IERC20.json";
import IUniswapV3PoolABI from "../contracts/abis/IUniswapV3Pool.json";
import { OracleService } from "./OracleService";

/*
 * Service for managing Uniswap V3 liquidity positions
 */
export class LiquidityManager {
	private provider: ethers.providers.JsonRpcProvider;
	private signer: ethers.Wallet;
	private positionManager: Contract;
	private walletAddress: string;
	private token0: string | null = null;
	private token1: string | null = null;
	private token0Decimals: number | null = null;
	private token1Decimals: number | null = null;
	private token0Contract: Contract | null = null;
	private token1Contract: Contract | null = null;
	private poolFee: number | null = null;
	private poolContract: Contract;

	constructor(private config: NetworkConfig, privateKey: string) {
		this.provider = new ethers.providers.JsonRpcProvider(config.rpcUrl);
		this.signer = new ethers.Wallet(privateKey, this.provider);
		this.walletAddress = this.signer.address;
		this.positionManager = new ethers.Contract(
			config.uniswap.positionManager,
			NonfungiblePositionManagerABI,
			this.signer
		);
		this.poolContract = new ethers.Contract(
			config.uniswap.poolAddress,
			IUniswapV3PoolABI,
			this.signer
		);

		console.log(`
      --------------------------------
      Liquidity Manager constructor
      --------------------------------
    `);
	}

	/**
	 * Initialize the Liquidity Manager with the correct pool and token order
	 * @param poolAddress The address of the pool to use
	 */
	public async initialize(poolContract: ethers.Contract): Promise<void> {
		try {
			// Store the pool contract reference
			this.poolContract = poolContract;
			this.token0 = await poolContract.token0();
			this.token1 = await poolContract.token1();
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
			this.poolFee = await poolContract.fee();

			console.log(`
        --------------------------------
        LiquidityManager initialized
        Pool ${poolContract.address} 
        token0: ${this.token0}
        token1: ${this.token1}
        token0 decimals: ${this.token0Decimals}
        token1 decimals: ${this.token1Decimals}
        fee: ${this.poolFee}
        --------------------------------
      `);
		} catch (error) {
			console.error("Error initializing LiquidityManager");
			throw error;
		}
	}

	/**
	 * Get the current pool fee
	 * @returns The pool fee as a number
	 */
	public getPoolFee(): number {
		return this.poolFee!;
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
		const allowance0 = await this.token0Contract?.allowance(
			this.walletAddress,
			this.positionManager.address
		);

		if (allowance0.lt(token0Amount)) {
			console.log(
				`Approving ${this.positionManager.address} to spend token0...`
			);
			const tx0 = await this.token0Contract?.approve(
				this.positionManager.address,
				token0Amount
			);
			await tx0.wait();
			console.log("Token0 approved");
		} else {
			console.log("Token0 already has sufficient allowance");
		}

		// Approve token1
		const allowance1 = await this.token1Contract?.allowance(
			this.walletAddress,
			this.positionManager.address
		);

		if (allowance1.lt(token1Amount)) {
			console.log(
				`Approving ${this.positionManager.address} to spend token1...`
			);
			const tx1 = await this.token1Contract?.approve(
				this.positionManager.address,
				token1Amount
			);
			await tx1.wait();
			console.log("Token1 approved");
		} else {
			console.log("Token1 already has sufficient allowance");
		}
	}

	/**
	 * Creates a new liquidity position
	 * @param tickLower Lower tick boundary
	 * @param tickUpper Upper tick boundary
	 * @param amount0Desired Desired amount of token0
	 * @param amount1Desired Desired amount of token1
	 * @returns Position ID and actual amounts used
	 */
	public async mintPosition(
		tickLower: number,
		tickUpper: number,
		amount0Desired: BigNumber,
		amount1Desired: BigNumber,
		amount0Min: BigNumber,
		amount1Min: BigNumber
	): Promise<{
		tokenId: number;
		amount0Used: BigNumber;
		amount1Used: BigNumber;
	}> {
		if (tickLower >= tickUpper) {
			throw new Error("Invalid tick bounds: lower must be < upper");
		}

		try {
			// Approve tokens for position manager
			await this.approveTokens(amount0Desired, amount1Desired);

			// Set deadline to 30 minutes from now
			const deadline = Math.floor(Date.now() / 1000) + 1800;

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
				deadline,
			};

			console.log(
				`Attempting to mint position with params:`,
				JSON.stringify(
					{
						fee: this.poolFee,
						tickLower,
						tickUpper,
						amount0Desired:
							ethers.utils.formatEther(amount0Desired),
						amount1Desired: ethers.utils.formatUnits(
							amount1Desired,
							6
						),
						amount0Min: ethers.utils.formatEther(amount0Min),
						amount1Min: ethers.utils.formatUnits(amount1Min, 6),
						recipient: this.walletAddress,
						deadline,
					},
					null,
					2
				)
			);

			const tx = await this.positionManager.mint(params);
			console.log(`Mint transaction hash: ${tx.hash}`);

			const receipt = await tx.wait();

			try {
				const transferEventTopic =
					"0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

				// Find the NFT transfer event
				const nftTransferLog = receipt.logs.find(
					(log: any) =>
						log.address.toLowerCase() ===
							this.positionManager.address.toLowerCase() &&
						log.topics[0] === transferEventTopic &&
						log.topics[1] ===
							"0x0000000000000000000000000000000000000000000000000000000000000000"
				);

				// NFT tokenId is in the 4th topic (index 3)
				const tokenId = parseInt(nftTransferLog.topics[3], 16);
				console.log(
					`Found tokenId ${tokenId} from Transfer log (topic index 3)`
				);

				console.log(`Position minted with token ID: ${tokenId}`);

				// Check for IncreaseLiquidity event to log actual amounts used
				let amount0Used = BigNumber.from(0);
				let amount1Used = BigNumber.from(0);

				const increaseLiquidityTopic =
					"0x3067048beee31b25b2f1681f88dac838c8bba36af25bfb2b7cf7473a5847e35f";

				// Find the IncreaseLiquidity event
				const increaseLiquidityLog = receipt.logs.find(
					(log: any) =>
						log.address.toLowerCase() ===
							this.positionManager.address.toLowerCase() &&
						log.topics[0] === increaseLiquidityTopic
				);

				// Parse the data field - it contains amounts used
				const decodedData = ethers.utils.defaultAbiCoder.decode(
					["uint256", "uint256", "uint256"],
					increaseLiquidityLog.data
				);
				amount0Used = decodedData[1];
				amount1Used = decodedData[2];

				console.log(`
            Position Created Stats:
            - Amount0 Used: ${ethers.utils.formatEther(amount0Used)} WETH
            - Amount1 Used: ${ethers.utils.formatUnits(amount1Used, 6)} USDC
          `);

				return { tokenId, amount0Used, amount1Used };
			} catch (error) {
				throw error;
			}
		} catch (error) {
			console.error("Error minting position");
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
		liquidity: BigNumber,
		amount0Min: BigNumber,
		amount1Min: BigNumber
	): Promise<{ amount0: BigNumber; amount1: BigNumber }> {
		try {
			// Get position info if liquidity not specified
			if (liquidity.isZero()) {
				const position = await this.getPositionInfo(tokenId);
				liquidity = position.liquidity;
			}

			if (liquidity.isZero()) {
				console.log(`Position ${tokenId} has no liquidity to decrease`);
				return {
					amount0: BigNumber.from(0),
					amount1: BigNumber.from(0),
				};
			}

			// Set deadline to 10 minutes from now
			const deadline = Math.floor(Date.now() / 1000) + 600;

			const params = {
				tokenId,
				liquidity,
				amount0Min,
				amount1Min,
				deadline,
			};

			console.log(
				`Decreasing liquidity for position ${tokenId} by ${liquidity.toString()}`
			);

			// Decrease liquidity
			const tx = await this.positionManager.decreaseLiquidity(params);
			console.log(`Decrease liquidity transaction hash: ${tx.hash}`);

			// Wait for the transaction to confirm
			const receipt = await tx.wait();

			const decreaseLiquidityTopic =
				"0x26f6a048ee9138f2c0ce266f322cb99228e8d619ae2bff30c67f8dcf9d2377b4";

			// Find the DecreaseLiquidity event
			const decreaseLiquidityLog = receipt.logs?.find(
				(log: any) =>
					log.topics[0] === decreaseLiquidityTopic &&
					log.address.toLowerCase() ===
						this.positionManager.address.toLowerCase()
			);

			// Decode the data field - format is (uint128 liquidity, uint256 amount0, uint256 amount1)
			const decodedData = ethers.utils.defaultAbiCoder.decode(
				["uint128", "uint256", "uint256"],
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
			console.error("Error decreasing liquidity:", error);
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
	): Promise<{ amount0: BigNumber; amount1: BigNumber }> {
		try {
			const MAX_UINT128 = BigNumber.from(
				"0xffffffffffffffffffffffffffffffff"
			); // 2^128 - 1

			const params = {
				tokenId,
				recipient: this.walletAddress,
				amount0Max: MAX_UINT128,
				amount1Max: MAX_UINT128,
			};

			console.log(`Collecting fees for position ${tokenId}`);

			// Collect fees
			const tx = await this.positionManager.collect(params);
			console.log(`Collect fees transaction hash: ${tx.hash}`);

			// Wait for the transaction to confirm
			const receipt = await tx.wait();

			const collectTopic =
				"0x40d0efd1a53d60ecbf40971b9daf7dc90178c3aadc7aab1765632738fa8b8f01";

			// Find the Collect event
			const collectLog = receipt.logs?.find(
				(log: any) =>
					log.topics[0] === collectTopic &&
					log.address.toLowerCase() ===
						this.positionManager.address.toLowerCase()
			);

			const decodedData = ethers.utils.defaultAbiCoder.decode(
				["address", "uint256", "uint256"],
				collectLog.data
			);

			const amount0 = decodedData[1];
			const amount1 = decodedData[2];

			return { amount0, amount1 };
		} catch (error) {
			console.error("Error collecting fees:", error);
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
			await tx.wait();

			console.log(`Position ${tokenId} burned`);
		} catch (error) {
			console.error("Error burning position");
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
			const priceLower = this.tickToPrice(
				position.tickLower,
				this.token0Decimals!,
				this.token1Decimals!
			);
			const priceUpper = this.tickToPrice(
				position.tickUpper,
				this.token0Decimals!,
				this.token1Decimals!
			);

			// Check if the position is in range
			const [, currentTick] = await this.poolContract.slot0();

			const inRange =
				position.tickLower <= currentTick &&
				currentTick <= position.tickUpper;

			// Get detailed info about this position
			return {
				tickLower: position.tickLower,
				tickUpper: position.tickUpper,
				liquidity: position.liquidity,
				inRange,
				tokenId,
				feeGrowthInside0LastX128: position.feeGrowthInside0LastX128,
				feeGrowthInside1LastX128: position.feeGrowthInside1LastX128,
				priceLower,
				priceUpper,
				isActive: !position.liquidity.isZero(),
			};
		} catch (error) {
			console.error(`Error getting position info for token ${tokenId}`);
			throw error;
		}
	}

	/**
	 * Closes a position entirely and burns the NFT
	 * @param tokenId ID of the position token
	 * @returns Amounts of token0 and token1 received
	 */
	public async closePosition(
		tokenId: number
	): Promise<{ amount0: BigNumber; amount1: BigNumber }> {
		try {
			// First get position info to know how much liquidity to remove
			const position = await this.getPositionInfo(tokenId);

			// Remove all liquidity
			const { amount0, amount1 } = await this.decreaseLiquidity(
				tokenId,
				position.liquidity,
				BigNumber.from(0), // min amount 0
				BigNumber.from(0) // min amount 1
			);

			// Collect any fees
			const fees = await this.collectFees(tokenId);

			// Burn the position NFT
			await this.burnPosition(tokenId);

			// Add up the liquidity amounts and fees
			const totalAmount0 = amount0.add(fees.amount0);
			const totalAmount1 = amount1.add(fees.amount1);

			console.log(`Position closed successfully`);
			console.log(
				`Received: ${ethers.utils.formatEther(
					totalAmount0
				)} token0 and ${ethers.utils.formatUnits(
					totalAmount1,
					6
				)} token1`
			);

			return {
				amount0: totalAmount0,
				amount1: totalAmount1,
			};
		} catch (error) {
			console.error("Error closing position:", error);
			throw error;
		}
	}

	/**
	 * Converts tick to price with decimal adjustment
	 * @param tick The tick to convert
	 * @param token0Decimals Decimals of token0
	 * @param token1Decimals Decimals of token1
	 * @returns The price at the given tick
	 */
	public tickToPrice(
		tick: number,
		token0Decimals: number,
		token1Decimals: number
	): number {
		const price =
			Math.pow(1.0001, tick) * 10 ** (token0Decimals - token1Decimals);
		return price;
	}

	/**
	 * Gets all positions owned by the user
	 * @returns Array of position information
	 */
	public async getUserPositions(): Promise<any[]> {
		console.log(`Getting positions for user: ${this.walletAddress}`);

		try {
			// Get the balance of position NFTs for this user
			const balance = await this.positionManager.balanceOf(
				this.walletAddress
			);

			// Get each position token ID
			const positions = [];
			for (let i = 0; i < balance; i++) {
				const tokenId = await this.positionManager.tokenOfOwnerByIndex(
					this.walletAddress,
					i
				);
				console.log(`Found position token ID: ${tokenId}`);

				const position = await this.getPositionInfo(tokenId);

				// console.log(`Position ${i}: ${JSON.stringify(position, null, 2)}`);

				positions.push(position);
			}

			console.log(`Retrieved ${positions.length} positions`);
			return positions;
		} catch (error) {
			console.error("Error getting user positions:", error);
			return [];
		}
	}

	/**
	 * Ensures that a tick is properly aligned to the pool's tick spacing
	 * @param tick The tick to align
	 * @param tickSpacing The pool's tick spacing
	 * @param roundUp Whether to round up or down
	 * @returns The aligned tick
	 */
	public alignTickToSpacing(
		tick: number,
		tickSpacing: number,
		roundUp: boolean = false
	): number {
		if (roundUp) {
			return Math.ceil(tick / tickSpacing) * tickSpacing;
		} else {
			return Math.floor(tick / tickSpacing) * tickSpacing;
		}
	}
}
