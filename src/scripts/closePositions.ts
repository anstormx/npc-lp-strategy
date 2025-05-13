import { ethers } from "ethers";
import { LiquidityManager } from "../services/LiquidityManager";
import { SwapService } from "../services/SwapService";
import baseConfig from "../config/base.config";
import dotenv from "dotenv";
import IUniswapV3PoolABI from "../contracts/abis/IUniswapV3Pool.json";

dotenv.config();

const privateKey = process.env.PRIVATE_KEY as string;

async function closePositions() {
  console.log("Starting position closing script...");
  
  // Initialize provider
  const provider = new ethers.providers.JsonRpcProvider(baseConfig.rpcUrl);
  
  // Initialize liquidityManager and swapService
  const liquidityManager = new LiquidityManager(baseConfig, privateKey, provider);
  const swapService = new SwapService(baseConfig, privateKey, provider);
  
  try {
    // Initialize the pool contract
    const poolContract = new ethers.Contract(
      baseConfig.uniswap.poolAddress,
      IUniswapV3PoolABI,
      provider
    );
    
    // Initialize the LiquidityManager with pool contract
    await liquidityManager.initialize(poolContract);
    
    // Set swap service for fee conversion to wstETH
    liquidityManager.setSwapService(swapService);
    
    // Get token decimals for proper formatting
    const token0Decimals = liquidityManager.getToken0Decimals();
    const token1Decimals = liquidityManager.getToken1Decimals();
    
    // Get all positions
    console.log("Fetching user positions...");
    const positions = await liquidityManager.getUserPositions();
    
    console.log(`Found ${positions.length} active positions`);
    
    if (positions.length === 0) {
      console.log("No active positions to close!");
      return;
    }
    
    // Close each position
    for (const position of positions) {
      const { tokenId } = position;
      
      console.log(`------------------------------------`);
      console.log(`Closing position ID: ${tokenId}`);
      console.log(`Price range: ${position.priceLower.toFixed(4)} - ${position.priceUpper.toFixed(4)}`);
      console.log(`Tick range: [${position.tickLower}, ${position.tickUpper}]`);
      console.log(`In range: ${position.inRange ? "Yes" : "No"}`);
      
      try {
        // Close the position, which will:
        // 1. Decrease all liquidity
        // 2. Collect all fees (will be converted to wstETH)
        // 3. Burn the NFT
        const result = await liquidityManager.closePosition(tokenId);
        
        console.log(`Position ${tokenId} successfully closed!`);
        console.log(`Received:`);
        console.log(`- Token0: ${ethers.utils.formatUnits(result.amount0, token0Decimals)}`);
        console.log(`- Token1: ${ethers.utils.formatUnits(result.amount1, token1Decimals)}`);
      } catch (error) {
        console.error(`Error closing position ${tokenId}:`, error);
      }
    }
    
    console.log(`------------------------------------`);
    console.log("Position closing operation completed!");
    
  } catch (error) {
    console.error("Error in closePositions script:", error);
  }
}

closePositions()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Unhandled error:", error);
    process.exit(1);
  }); 