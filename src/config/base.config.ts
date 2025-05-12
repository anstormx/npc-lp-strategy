import { NetworkConfig } from '../utils/types';
import dotenv from 'dotenv';
dotenv.config();

const rpcUrl = process.env.RPC_URL;

if (!rpcUrl) {
  throw new Error('RPC_URL is not defined in the environment variables');
}

const baseMainnet: NetworkConfig = {
  network: 'base',
  rpcUrl: rpcUrl,
  chainId: 8453,
  tokens: {
    WETH: '0x4200000000000000000000000000000000000006',
    USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  },
  uniswap: {
    swapRouter: '0x2626664c2603336E57B271c5C0b26F421741e481',
    positionManager: '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1',
    factory: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD',
    poolAddress: '0x6c561B446416E1A00E8E93E221854d6eA4171372',
  },
  strategy: {
    checkInterval: 5000,
    slippagePercent: 2.5,
    widthPercent: 20,
  },
};

export default baseMainnet; 