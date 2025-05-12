import { DatabaseService } from './DatabaseService';
import { OracleService } from './OracleService';
import { ActionEvent, ActionType, NetworkConfig, StrategyStats } from '../utils/types';
import { ethers } from 'ethers';

/**
 * Service that combines Oracle data fetching with Database storage
 * for real-time market tracking and historical analysis
 */
export class DataTrackingService {
  private oracleService!: OracleService;
  private dbService: DatabaseService;
  private trackingInterval: NodeJS.Timeout | null = null;
  private isTracking: boolean = false;
  private intervalMs: number;
  private lastCollectionTime: number = 0;

  constructor(
    config: NetworkConfig,
    privateKey: string,
    mongoUri: string,
    dbName: string = 'uniswap_strategy',
    intervalSeconds: number = 60,
  ) {
    // Initialize services
    this.dbService = new DatabaseService(mongoUri, dbName);
    this.intervalMs = intervalSeconds * 1000;
    
    console.log(`
      --------------------------------
      DataTrackingService constructor
      --------------------------------
    `);
  }

  /**
   * Initialize connections to database and blockchain
   * @param poolContract Optional contract to initialize the oracle with
   */
  public async initialize(oracleService: OracleService): Promise<void> {
    try {
      // Connect to database
      await this.dbService.connect();
      console.log('Database connection established');
      
      this.oracleService = oracleService;
      console.log('Oracle initialized with pool contract');
      
    } catch (error: any) {
      console.error('Failed to initialize DataTrackingService:', error.message);
      throw new Error(`DataTrackingService initialization failed: ${error.message}`);
    }
  }

  /**
   * Start tracking price data at regular intervals
   */
  public async startTracking(): Promise<void> {
    if (this.isTracking) {
      console.log('Tracking already in progress');
      return;
    }
    
    this.isTracking = true;
    console.log('Starting data tracking...');
    
    // Collect data immediately on start
    await this.collectAndStoreData();
    
    // Set up interval for regular collection
    this.trackingInterval = setInterval(async () => {
      await this.collectAndStoreData();
    }, this.intervalMs);
    
    console.log(`Data tracking started with ${this.intervalMs/1000}s interval`);
  }
  
  /**
   * Stop tracking price data
   */
  public stopTracking(): void {
    if (!this.isTracking || !this.trackingInterval) {
      console.log('No tracking in progress to stop');
      return;
    }
    
    clearInterval(this.trackingInterval);
    this.trackingInterval = null;
    this.isTracking = false;
    console.log('Data tracking stopped');
  }
  
  /**
   * Collect current price data and store in database
   */
  private async collectAndStoreData(): Promise<void> {
    try {
      // Fetch current price data from oracle
      const priceData = await this.oracleService.getOraclePrice();
      
      // Record current time
      const currentTime = Math.floor(Date.now() / 1000);
      
      // Store price data in database
      await this.dbService.savePriceData(priceData);
      
      // Log collection (only if more than 5 minutes since last log to avoid spam)
      if (currentTime - this.lastCollectionTime > 300) {
        console.log(`Collected price data: $${priceData.uniswapPrice} at ${new Date().toISOString()}`);
        this.lastCollectionTime = currentTime;
      }
      
      // Record price data collection action
      await this.dbService.recordAction({
        type: ActionType.PRICE_DATA_COLLECTED,
        timestamp: currentTime,
        data: {
          price: priceData.uniswapPrice
        }
      });
    } catch (error) {
      console.error('Error collecting and storing data:', error);
    }
  }
  
  /**
   * Record a position creation event
   * @param tokenId Position token ID
   * @param position Position details
   */
  public async recordPositionCreated(tokenId: number, position: any): Promise<void> {
    try {
      // Save position to database
      await this.dbService.savePosition({
        ...position,
        tokenId,
        isActive: true // Explicitly mark position as active
      });
      
      // Record action
      await this.dbService.recordAction({
        type: ActionType.POSITION_CREATED,
        timestamp: Math.floor(Date.now() / 1000),
        tokenId,
        data: {
          tickLower: position.tickLower,
          tickUpper: position.tickUpper,
          priceLower: position.priceLower,
          priceUpper: position.priceUpper
        },
        token0Amount: position.amount0,
        token1Amount: position.amount1
      });
      
      console.log(`Recorded position creation: ID ${tokenId}`);
    } catch (error) {
      console.error('Error recording position creation:', error);
    }
  }
  
  /**
   * Record a position creation failure
   * @param positionType Type of position (e.g., 'upper', 'lower')
   * @param error Error message or object
   * @param tickData Tick data for the failed position
   */
  public async recordPositionCreationFailed(
    positionType: string,
    error: any,
    tickData?: { tickLower?: number, tickUpper?: number }
  ): Promise<void> {
    try {
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      // Record action
      await this.dbService.recordAction({
        type: ActionType.POSITION_CREATION_FAILED,
        timestamp: Math.floor(Date.now() / 1000),
        data: {
          positionType,
          error: errorMessage,
          ...tickData
        }
      });
      
      console.log(`Recorded position creation failure for ${positionType} position`);
    } catch (dbError) {
      console.error('Error recording position creation failure:', dbError);
    }
  }
  
  /**
   * Record a position closed event
   * @param tokenId Position token ID
   * @param amount0 Amount of token0 received
   * @param amount1 Amount of token1 received
   */
  public async recordPositionClosed(tokenId: number, amount0: ethers.BigNumber, amount1: ethers.BigNumber): Promise<void> {
    try {
      // Get the position from database
      const position = await this.dbService.getPosition(tokenId.toString());
      
      if (position) {
        // Update position as inactive
        position.isActive = false;
        await this.dbService.savePosition(position);
      }
      
      // Record action
      await this.dbService.recordAction({
        type: ActionType.POSITION_CLOSED,
        timestamp: Math.floor(Date.now() / 1000),
        tokenId,
        token0Amount: amount0,
        token1Amount: amount1
      });
      
      console.log(`Recorded position closure: ID ${tokenId}`);
    } catch (error) {
      console.error('Error recording position closure:', error);
    }
  }

  /**
   * Record a position close failure
   * @param tokenId Position token ID
   * @param error Error message or object
   */
  public async recordPositionCloseFailed(tokenId: number, error: any): Promise<void> {
    try {
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      // Record action
      await this.dbService.recordAction({
        type: ActionType.POSITION_CLOSE_FAILED,
        timestamp: Math.floor(Date.now() / 1000),
        tokenId,
        data: {
          error: errorMessage
        }
      });
      
      console.log(`Recorded position close failure for ID ${tokenId}`);
    } catch (dbError) {
      console.error('Error recording position close failure:', dbError);
    }
  }

  /**
   * Record a stray position detected event
   * @param tokenId Position token ID
   * @param position Position details
   */
  public async recordStrayPositionDetected(tokenId: number, position: any): Promise<void> {
    try {
      // Record action
      await this.dbService.recordAction({
        type: ActionType.STRAY_POSITION_DETECTED,
        timestamp: Math.floor(Date.now() / 1000),
        tokenId,
        data: {
          tickLower: position.tickLower,
          tickUpper: position.tickUpper,
          liquidity: position.liquidity.toString()
        }
      });
      
      console.log(`Recorded stray position detection: ID ${tokenId}`);
    } catch (error) {
      console.error('Error recording stray position detection:', error);
    }
  }

  /**
   * Record a stray position closed event
   * @param tokenId Position token ID
   * @param amount0 Amount of token0 received
   * @param amount1 Amount of token1 received
   */
  public async recordStrayPositionClosed(tokenId: number, amount0: ethers.BigNumber, amount1: ethers.BigNumber): Promise<void> {
    try {
      // Record action
      await this.dbService.recordAction({
        type: ActionType.STRAY_POSITION_CLOSED,
        timestamp: Math.floor(Date.now() / 1000),
        tokenId,
        token0Amount: amount0,
        token1Amount: amount1
      });
      
      console.log(`Recorded stray position closure: ID ${tokenId}`);
    } catch (error) {
      console.error('Error recording stray position closure:', error);
    }
  }

  /**
   * Record a swap failure
   * @param fromToken Source token address
   * @param toToken Destination token address
   * @param amount Amount to swap (as a number in human-readable form)
   * @param error Error message or object
   */
  public async recordSwapFailed(
    fromToken: string, 
    toToken: string, 
    amount: number | ethers.BigNumber, 
    error: any
  ): Promise<void> {
    try {
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      // Convert amount to string for storage
      let amountString: string;
      if (typeof amount === 'number') {
        amountString = amount.toString();
      } else {
        // If it's a BigNumber, format it
        amountString = amount.toString();
      }
      
      // Record action
      await this.dbService.recordAction({
        type: ActionType.SWAP_FAILED,
        timestamp: Math.floor(Date.now() / 1000),
        data: {
          fromToken,
          toToken,
          amount: amountString,
          error: errorMessage
        }
      });
      
      console.log(`Recorded swap failure: ${fromToken} -> ${toToken}`);
    } catch (dbError) {
      console.error('Error recording swap failure:', dbError);
    }
  }

  /**
   * Record a rebalance failure
   * @param reason Reason for rebalance failure
   * @param error Error message or object
   */
  public async recordRebalanceFailed(reason: string, error: any): Promise<void> {
    try {
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      // Record action
      await this.dbService.recordAction({
        type: ActionType.REBALANCE_FAILED,
        timestamp: Math.floor(Date.now() / 1000),
        data: {
          reason,
          error: errorMessage
        }
      });
      
      console.log(`Recorded rebalance failure: ${reason}`);
    } catch (dbError) {
      console.error('Error recording rebalance failure:', dbError);
    }
  }

  /**
   * Record a general strategy error
   * @param component Component where error occurred
   * @param error Error message or object
   * @param additionalData Any additional data to record
   */
  public async recordStrategyError(component: string, error: any, additionalData?: any): Promise<void> {
    try {
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      // Record action
      await this.dbService.recordAction({
        type: ActionType.STRATEGY_ERROR,
        timestamp: Math.floor(Date.now() / 1000),
        data: {
          component,
          error: errorMessage,
          ...additionalData
        }
      });
      
      console.log(`Recorded strategy error in ${component}`);
    } catch (dbError) {
      console.error('Error recording strategy error:', dbError);
    }
  }
  
  /**
   * Record fees collected from a position
   * @param tokenId Position token ID
   * @param amount0 Amount of token0 collected
   * @param amount1 Amount of token1 collected
   */
  public async recordFeesCollected(tokenId: number, amount0: ethers.BigNumber, amount1: ethers.BigNumber): Promise<void> {
    try {
      // Record action
      await this.dbService.recordAction({
        type: ActionType.FEES_COLLECTED,
        timestamp: Math.floor(Date.now() / 1000),
        tokenId,
        token0Amount: amount0,
        token1Amount: amount1
      });
      
      console.log(`Recorded fees collection: ID ${tokenId}`);
    } catch (error) {
      console.error('Error recording fees collection:', error);
    }
  }
  
  /**
   * Get recent price history
   * @param limit Number of entries to return
   * @returns Recent price data
   */
  public async getPriceHistory(limit: number = 100): Promise<any[]> {
    return this.dbService.getRecentPrices(limit);
  }
  
  /**
   * Get recent actions
   * @param limit Number of entries to return
   * @returns Recent action events
   */
  public async getRecentActions(limit: number = 50): Promise<ActionEvent[]> {
    return this.dbService.getRecentActions(limit);
  }
  
  /**
   * Cleanup and close connections
   */
  public async shutdown(): Promise<void> {
    this.stopTracking();
    await this.dbService.disconnect();
    console.log('DataTrackingService shutdown complete');
  }

  /**
   * Save strategy stats to database
   * @param stats Strategy stats to save
   */
  public async saveStrategyStats(stats: StrategyStats): Promise<void> {
    await this.dbService.saveStats(stats);
    console.log('Strategy stats saved to database');
  }
} 