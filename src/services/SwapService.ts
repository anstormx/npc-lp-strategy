import { ethers, BigNumber } from "ethers";
import {
	AllowanceResponse,
	ApprovalResponse,
	NetworkConfig,
	SwapResponse,
} from "../utils/types";
import axios, { AxiosRequestConfig, AxiosResponse } from "axios";
import dotenv from "dotenv";

dotenv.config();

// Constants
const ONEINCH_API_URL = "https://api.1inch.dev/swap/v6.0";
const API_KEY = process.env.ONEINCH_API_KEY as string;

/**
 * Minimal service for swapping tokens using 1inch aggregator API
 */
export class SwapService {
	private provider: ethers.providers.JsonRpcProvider;
	private signer: ethers.Wallet;
	private walletAddress: string;
	private nativeETHAddress: string =
		"0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
	private apiKey: string = API_KEY;
	private lastRequestTime: number = 0;
	private allowanceCache: Map<string, BigNumber> = new Map();

	constructor(private config: NetworkConfig, privateKey: string, provider: ethers.providers.JsonRpcProvider) {
		this.provider = provider;
		this.signer = new ethers.Wallet(privateKey, this.provider);
		this.walletAddress = this.signer.address;

		console.log(`
      --------------------------------
      Initialized SwapService
      --------------------------------
    `);
	}

	/**
	 * Execute API request with rate limiting and retry logic
	 */
	private async executeApiRequest<T>(
		url: string,
		config: AxiosRequestConfig
	): Promise<AxiosResponse<T>> {
		const now = Date.now();
		const timeSinceLastRequest = now - this.lastRequestTime;

		if (timeSinceLastRequest < 1100 && this.lastRequestTime !== 0) {
			const waitTime = 1100 - timeSinceLastRequest;
			await new Promise((resolve) => setTimeout(resolve, waitTime));
		}

		// Update last request time
		this.lastRequestTime = Date.now();

		// Try the request with exponential backoff on rate limit errors
		try {
			const response = await axios.get<T>(url, config);
			return response;
		} catch (error) {
			console.error("Error executing API request");
			throw error;
		}
	}

	/**
	 * Helper to check if an address is native ETH
	 */
	private isNativeETH(tokenAddress: string): boolean {
		return (
			tokenAddress.toLowerCase() === this.nativeETHAddress.toLowerCase()
		);
	}

	/**
	 * Approves token for spending by 1inch router
	 */
	public async approveToken(
		tokenAddress: string,
		amount: BigNumber = ethers.constants.MaxUint256
	): Promise<void> {
		// Skip approval for native ETH
		if (this.isNativeETH(tokenAddress)) {
			console.log("No approval needed for native ETH");
			return;
		}

		try {
			// Get approval data from 1inch API
			const approvalUrl = `${ONEINCH_API_URL}/${this.config.chainId}/approve/transaction`;
			const response = await this.executeApiRequest<ApprovalResponse>(
				approvalUrl,
				{
					headers: {
						Authorization: `Bearer ${this.apiKey}`,
						accept: "application/json",
					},
					params: {
						tokenAddress,
						amount: amount.toString(),
					},
				}
			);

			const approvalData = response.data;

			// Execute approval transaction
			const tx = await this.signer.sendTransaction({
				to: approvalData.to,
				data: approvalData.data,
				value: BigNumber.from(0),
			});

			console.log(`Approval transaction hash: ${tx.hash}`);
			const receipt = await tx.wait();
			console.log(`Approval confirmed in block ${receipt.blockNumber}`);
			
			// Update the allowance cache with the new approval amount
			if (amount.eq(ethers.constants.MaxUint256)) {
				this.allowanceCache.set(tokenAddress.toLowerCase(), ethers.constants.MaxUint256);
			}
		} catch (error) {
			console.error("Error approving token:", error);
			throw error;
		}
	}

	/**
	 * Checks token allowance for 1inch router
	 */
	public async checkAllowance(tokenAddress: string): Promise<BigNumber> {
		const normalizedAddress = tokenAddress.toLowerCase();
		
		// Native ETH doesn't need approval
		if (this.isNativeETH(normalizedAddress)) {
			return ethers.constants.MaxUint256;
		}

		// Check if we have a cached unlimited allowance
		const cachedAllowance = this.allowanceCache.get(normalizedAddress);
		if (cachedAllowance && cachedAllowance.eq(ethers.constants.MaxUint256)) {
			console.log(`Using cached unlimited allowance for ${normalizedAddress}`);
			return cachedAllowance;
		}
		
		try {
			const allowanceUrl = `${ONEINCH_API_URL}/${this.config.chainId}/approve/allowance`;
			const response = await this.executeApiRequest<AllowanceResponse>(
				allowanceUrl,
				{
					headers: {
						Authorization: `Bearer ${this.apiKey}`,
						accept: "application/json",
					},
					params: {
						tokenAddress: normalizedAddress,
						walletAddress: this.walletAddress,
					},
				}
			);

			const allowance = BigNumber.from(response.data.allowance);
			
			// Cache the allowance
			this.allowanceCache.set(normalizedAddress, allowance);
			
			return allowance;
		} catch (error) {
			console.error("Error checking allowance:", error);
			return BigNumber.from(0);
		}
	}

	/**
	 * Ensures token has sufficient allowance for the swap
	 */
	public async ensureAllowance(
		tokenAddress: string,
		amount: BigNumber
	): Promise<void> {
		const normalizedAddress = tokenAddress.toLowerCase();
		
		// Skip allowance check for native ETH
		if (this.isNativeETH(normalizedAddress)) {
			return;
		}

		try {
			// Check if we have a cached unlimited allowance first
			const cachedAllowance = this.allowanceCache.get(normalizedAddress);
			if (cachedAllowance && cachedAllowance.eq(ethers.constants.MaxUint256)) {
				console.log(`Token ${normalizedAddress} has unlimited allowance (cached)`);
				return;
			}
			
			const allowance = await this.checkAllowance(normalizedAddress);

			if (allowance.lt(amount)) {
				console.log(
					`Insufficient allowance (${ethers.utils.formatEther(
						allowance
					)}), approving token...`
				);
				await this.approveToken(normalizedAddress);
			} else {
				console.log(`Sufficient allowance already exists`);
			}
		} catch (error) {
			console.error(
				`Error ensuring allowance for ${normalizedAddress}:`,
				error
			);
			// Still try to approve in case of error
			await this.approveToken(normalizedAddress);
		}
	}

	/**
	 * Executes a token swap using the 1inch API
	 */
	public async swap(
		fromTokenAddress: string,
		toTokenAddress: string,
		amount: BigNumber,
		slippagePercent: number = 2.5
	): Promise<ethers.providers.TransactionReceipt> {
		const normalizedFromToken = fromTokenAddress.toLowerCase();
		const normalizedToToken = toTokenAddress.toLowerCase();
		
		console.log(
			`Swapping tokens with 1inch: from ${normalizedFromToken} to ${normalizedToToken}`
		);
		console.log(
			`Amount: ${ethers.utils.formatEther(
				amount
			)}, Slippage: ${slippagePercent}%`
		);

		// Ensure we have approval (skip for native ETH)
		if (!this.isNativeETH(normalizedFromToken)) {
			await this.ensureAllowance(normalizedFromToken, amount);
		} else {
			console.log("Swapping native ETH - no approval needed");
		}

		try {
			const srcToken = this.isNativeETH(normalizedFromToken)
				? this.nativeETHAddress
				: normalizedFromToken;
			const dstToken = this.isNativeETH(normalizedToToken)
				? this.nativeETHAddress
				: normalizedToToken;

			// Get swap transaction data from 1inch API
			const swapUrl = `${ONEINCH_API_URL}/${this.config.chainId}/swap`;
			const response = await this.executeApiRequest<SwapResponse>(
				swapUrl,
				{
					headers: {
						Authorization: `Bearer ${this.apiKey}`,
						accept: "application/json",
					},
					params: {
						src: srcToken,
						dst: dstToken,
						amount: amount.toString(),
						from: this.walletAddress,
						slippage: slippagePercent,
						includeTokensInfo: true,
						disableEstimate: false,
					},
				}
			);

			const swapData = response.data;

			// Validate swap data to avoid undefined values
			if (!swapData || !swapData.tx) {
				throw new Error(
					"Invalid or incomplete swap data received from 1inch API"
				);
			}

			// Format output amount using correct token decimals
			if (swapData.dstAmount && swapData.dstToken) {
				const dstDecimals = swapData.dstToken.decimals || 18;
				const formattedAmount = ethers.utils.formatUnits(
					swapData.dstAmount,
					dstDecimals
				);
				console.log(
					`Expected output amount: ${formattedAmount} ${swapData.dstToken.symbol}`
				);
			} else {
				// Fallback if token info is not available
				console.log(
					`Expected output amount (raw): ${swapData.dstAmount || "unknown"}`
				);
			}

			// Set value if sending ETH
			const value = this.isNativeETH(normalizedFromToken)
				? amount
				: BigNumber.from(0);

			// Execute the swap transaction
			const tx = await this.signer.sendTransaction({
				to: swapData.tx.to,
				data: swapData.tx.data,
				value,
				gasLimit: swapData.tx.gas,
			});

			console.log(`Swap transaction submitted: ${tx.hash}`);
			const receipt = await tx.wait();
			return receipt;
		} catch (error) {
			console.error("Error swapping tokens");
			throw error;
		}
	}
}
