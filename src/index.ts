import dotenv from "dotenv";
import baseMainnet from "./config/base.config";
import { CustomPoolStrategy } from "./services/CustomPoolStrategy";

// Load environment variables
dotenv.config();

// Start the strategy
async function main() {
	try {
		// Initialize strategy with MongoDB if URI is provided
		const strategy = new CustomPoolStrategy(baseMainnet, process.env.PRIVATE_KEY as string);

		// Initialize services
		await strategy.initialize();

		// Start the strategy
		await strategy.start();
	} catch (error) {
		console.error("Error starting strategy:", error);
		process.exit(1);
	}
}

// Execute main function
main().catch(console.error);
