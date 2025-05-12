import { NetworkConfig } from '../utils/types';
import dotenv from 'dotenv';
dotenv.config();

const baseMainnet: NetworkConfig = {
  network: 'base',
  rpcUrl: process.env.RPC_URL as string,
  chainId: 8453,
  uniswap: {
    swapRouter: '0x2626664c2603336E57B271c5C0b26F421741e481',
    positionManager: '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1',
    factory: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD',
    poolAddress: '0x6c561B446416E1A00E8E93E221854d6eA4171372',
  },
  strategy: {
    checkInterval: 5000,
    widthPercent: 20,
  },
  database: {
    mongoUri: process.env.MONGO_URI as string,
    dbName: process.env.DB_NAME as string,
  }
};

export default baseMainnet; 