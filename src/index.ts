import dotenv from 'dotenv';
import baseMainnet from './config/base.config';
import { CustomPoolStrategy } from './services/CustomPoolStrategy';

// Load environment variables
dotenv.config();

// Check for required environment variables
if (!process.env.PRIVATE_KEY) {
  console.error('PRIVATE_KEY environment variable is required');
  process.exit(1);
}

if (!process.env.RPC_URL) {
  console.error('RPC_URL environment variable is required');
  process.exit(1);
}

if (!process.env.MONGO_URI) {
    console.error('MONGO_URI environment variable is required');
    process.exit(1);
}

// Initialize the strategy controller with the Base mainnet config
const privateKey = process.env.PRIVATE_KEY;
const mongoUri = process.env.MONGO_URI;

// Start the strategy
async function main() {
  try {
    // Initialize strategy with MongoDB if URI is provided
    const strategy = new CustomPoolStrategy(
      baseMainnet, 
      privateKey,
      mongoUri
    );

    // Initialize services
    await strategy.initialize();

    // Start the strategy
    await strategy.start();
  } catch (error) {
    console.error('Error starting strategy:', error);
    process.exit(1);
  }
}

// Execute main function
main().catch(console.error); 