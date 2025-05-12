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
const ROUTER_ADDRESS = "0x111111125421cA6dc452d289314280a0f8842A65";
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

	constructor(private config: NetworkConfig, privateKey: string) {
		this.provider = new ethers.providers.JsonRpcProvider(config.rpcUrl, {
			chainId: config.chainId,
			name: config.network,
		});
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
		} catch (error) {
			console.error("Error approving token:", error);
			throw error;
		}
	}

	/**
	 * Checks token allowance for 1inch router
	 */
	public async checkAllowance(tokenAddress: string): Promise<BigNumber> {
		// Native ETH doesn't need approval
		if (this.isNativeETH(tokenAddress)) {
			return ethers.constants.MaxUint256;
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
						tokenAddress,
						walletAddress: this.walletAddress,
					},
				}
			);

			return BigNumber.from(response.data.allowance);
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
		// Skip allowance check for native ETH
		if (this.isNativeETH(tokenAddress)) {
			return;
		}

		try {
			const allowance = await this.checkAllowance(tokenAddress);

			if (allowance.lt(amount)) {
				console.log(
					`Insufficient allowance (${ethers.utils.formatEther(
						allowance
					)}), approving token...`
				);
				await this.approveToken(tokenAddress);
			} else {
				console.log(`Sufficient allowance already exists`);
			}
		} catch (error) {
			console.error(
				`Error ensuring allowance for ${tokenAddress}:`,
				error
			);
			// Still try to approve in case of error
			await this.approveToken(tokenAddress);
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
		console.log(
			`Swapping tokens with 1inch: from ${fromTokenAddress} to ${toTokenAddress}`
		);
		console.log(
			`Amount: ${ethers.utils.formatEther(
				amount
			)}, Slippage: ${slippagePercent}%`
		);

		// Ensure we have approval (skip for native ETH)
		if (!this.isNativeETH(fromTokenAddress)) {
			await this.ensureAllowance(fromTokenAddress, amount);
		} else {
			console.log("Swapping native ETH - no approval needed");
		}

		try {
			const srcToken = this.isNativeETH(fromTokenAddress)
				? this.nativeETHAddress
				: fromTokenAddress;
			const dstToken = this.isNativeETH(toTokenAddress)
				? this.nativeETHAddress
				: toTokenAddress;

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

			// Log with safe toString() to avoid formatEther errors with undefined
			if (swapData.dstAmount) {
				console.log(
					`Expected output amount: ${ethers.utils.formatEther(
						swapData.dstAmount
					)}`
				);
			}

			// Set value if sending ETH
			const value = this.isNativeETH(fromTokenAddress)
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
