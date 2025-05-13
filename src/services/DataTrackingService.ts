import { DatabaseService } from './DatabaseService';
import { OracleService } from './OracleService';
import { ActionEvent, ActionType, NetworkConfig, PositionInfo, StrategyStats, PriceData } from '../utils/types';
import { ethers, BigNumber } from 'ethers';
import { EventEmitter } from 'events';

/**
 * Position data needed for tracking
 */
export interface TrackablePositionData {
  tickLower: number;
  tickUpper: number;
  priceLower: number;
  priceUpper: number;
  liquidity: BigNumber;
  amount0?: BigNumber;
  amount1?: BigNumber;
  token0Amount?: BigNumber;
  token1Amount?: BigNumber;
}

/**
 * Stray position data with minimal required fields
 */
export interface StrayPositionData {
  tokenId: number;
  tickLower: number;
  tickUpper: number;
  liquidity: BigNumber;
}

/**
 * Database error information
 */
export interface DbErrorInfo {
  operation: string;
  timestamp: number;
  error: string;
  isCritical: boolean;
}

/**
 * Database health status
 */
export interface DbHealthStatus {
  isConnected: boolean;
  lastSuccessfulOperation: number;
  failedOperations: number;
  consecutiveFailures: number;
  criticalFailures: number;
  errors: DbErrorInfo[];
}

/**
 * Events emitted by DataTrackingService
 */
export enum TrackingServiceEvent {
  DB_ERROR = 'db_error',
  CRITICAL_ERROR = 'critical_error',
  CONNECTION_RESTORED = 'connection_restored'
}

/**
 * Service that combines Oracle data fetching with Database storage
 * for real-time market tracking and historical analysis
 */
export class DataTrackingService extends EventEmitter {
  private oracleService!: OracleService;
  private dbService: DatabaseService;
  private trackingInterval: NodeJS.Timeout | null = null;
  private isTracking: boolean = false;
  private intervalMs: number;
  private lastCollectionTime: number = 0;
  
  // Error tracking
  private dbErrors: DbErrorInfo[] = [];
  private lastSuccessfulOperation: number = 0;
  private failedOperations: number = 0;
  private consecutiveFailures: number = 0;
  private criticalFailures: number = 0;
  private isConnected: boolean = false;
  private maxStoredErrors: number = 50;

  // Logging settings
  private logIntervalSeconds: number = 300; // Default to 5 minutes between console logs

  // Price data buffering
  private priceDataBuffer: PriceData[] = [];
  private maxBufferSize: number = 10;
  private bufferFlushIntervalMs: number = 5 * 60 * 1000; // 5 minutes
  private lastBufferFlush: number = 0;
  private bufferFlushInterval: NodeJS.Timeout | null = null;
  private lastSavedPrice: number | null = null;
  private significantPriceChangeThreshold: number = 0.005; // 0.5% change
  private dataRetentionDays: number = 30; // Keep 30 days of price data by default
  
  constructor(
    config: NetworkConfig,
    privateKey: string,
    mongoUri: string,
    dbName: string = 'uniswap_strategy',
    intervalSeconds: number = 60,
    options: {
      bufferSize?: number;
      bufferFlushMinutes?: number;
      priceChangeThreshold?: number;
      dataRetentionDays?: number;
      logIntervalSeconds?: number;
    } = {}
  ) {
    super();
    // Initialize services
    this.dbService = new DatabaseService(mongoUri, dbName);
    this.intervalMs = intervalSeconds * 1000;
    
    // Configure buffer settings if provided
    if (options.bufferSize) {
      this.maxBufferSize = options.bufferSize;
    }
    
    if (options.bufferFlushMinutes) {
      this.bufferFlushIntervalMs = options.bufferFlushMinutes * 60 * 1000;
    }
    
    if (options.priceChangeThreshold) {
      this.significantPriceChangeThreshold = options.priceChangeThreshold;
    }
    
    if (options.dataRetentionDays) {
      this.dataRetentionDays = options.dataRetentionDays;
    }
    
    if (options.logIntervalSeconds) {
      this.logIntervalSeconds = options.logIntervalSeconds;
    }
    
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
      this.isConnected = true;
      this.lastSuccessfulOperation = Math.floor(Date.now() / 1000);
      
      this.oracleService = oracleService;
      console.log('Oracle initialized with pool contract');
      
      // Run initial data retention cleanup
      await this.purgeOldPriceData();
      
    } catch (error: any) {
      this.isConnected = false;
      this.recordDbError('initialize', error, true);
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
    
    // Set up buffer flush interval
    this.bufferFlushInterval = setInterval(async () => {
      await this.flushPriceDataBuffer(true);
    }, this.bufferFlushIntervalMs);
    
    console.log(`Data tracking started with ${this.intervalMs/1000}s interval`);
    console.log(`Buffer flush scheduled every ${this.bufferFlushIntervalMs/1000/60} minutes`);
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
    
    if (this.bufferFlushInterval) {
      clearInterval(this.bufferFlushInterval);
      this.bufferFlushInterval = null;
    }
    
    // Flush any remaining data
    this.flushPriceDataBuffer(true).catch(err => {
      console.error('Error flushing price data buffer during shutdown:', err);
    });
    
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
      
      // Determine if this price change is significant
      const isSignificantChange = this.isSignificantPriceChange(priceData.uniswapPrice);
      
      // Add to buffer
      this.priceDataBuffer.push(priceData);
      
      // Record current time
      const currentTime = Math.floor(Date.now() / 1000);
      
      // Update last collection time tracking - only log based on configurable interval
      if (currentTime - this.lastCollectionTime > this.logIntervalSeconds) {
        console.log(`Collected price data: $${priceData.uniswapPrice} at ${new Date().toISOString()}`);
        this.lastCollectionTime = currentTime;
      }
      
      // Try to flush buffer if:
      // 1. Buffer is full
      // 2. It's been more than bufferFlushIntervalMs since last flush
      // 3. There's a significant price change
      const shouldFlush = 
        this.priceDataBuffer.length >= this.maxBufferSize || 
        currentTime - this.lastBufferFlush >= this.bufferFlushIntervalMs/1000 ||
        isSignificantChange;
        
      if (shouldFlush) {
        await this.flushPriceDataBuffer(isSignificantChange);
      }
      
      // Record price data collection action (only for significant changes to reduce action writes)
      if (isSignificantChange) {
        await this.recordAction({
          type: ActionType.PRICE_DATA_COLLECTED,
          data: {
            price: priceData.uniswapPrice
          }
        }, 'price data collection (significant change)', false); // Non-critical operation
      }
      
    } catch (error) {
      console.error('Error collecting and storing data:', error);
      this.recordDbError('collectAndStoreData', error, false);
    }
  }
  
  /**
   * Check if a price change is significant enough to record
   * @param currentPrice The current price to compare
   * @returns True if the change is significant, false otherwise
   */
  private isSignificantPriceChange(currentPrice: number): boolean {
    // If we don't have a last price, this is significant
    if (this.lastSavedPrice === null) {
      return true;
    }
    
    // Calculate percentage change
    const change = Math.abs(currentPrice - this.lastSavedPrice) / this.lastSavedPrice;
    
    // Return true if change exceeds threshold
    return change >= this.significantPriceChangeThreshold;
  }
  
  /**
   * Flush the price data buffer to the database
   * @param forceFlush Whether to force flushing even if buffer is small
   */
  private async flushPriceDataBuffer(forceFlush: boolean = false): Promise<void> {
    // Only flush if we have data and either forcing or buffer is full enough
    if (this.priceDataBuffer.length === 0) {
      return;
    }
    
    if (!forceFlush && this.priceDataBuffer.length < Math.max(2, this.maxBufferSize / 2)) {
      return;
    }
    
    try {
      // Make a copy of the buffer
      const dataToFlush = [...this.priceDataBuffer];
      
      // Clear the buffer
      this.priceDataBuffer = [];
      
      // Store data in database using bulk operation
      // Use savePriceData for each item since savePriceDataBatch doesn't exist
      for (const priceData of dataToFlush) {
        await this.dbService.savePriceData(priceData);
      }
      
      // Update last saved price
      if (dataToFlush.length > 0) {
        this.lastSavedPrice = dataToFlush[dataToFlush.length - 1].uniswapPrice;
      }
      
      // Update last flush time
      this.lastBufferFlush = Math.floor(Date.now() / 1000);
      
      // Log success
      if (dataToFlush.length > 1) {
        console.log(`Flushed ${dataToFlush.length} price data points to database`);
      }
      
    } catch (error) {
      console.error('Error flushing price data buffer:', error);
      
      // If we failed to flush, keep the data in the buffer
      // but limit buffer size to avoid memory issues
      this.priceDataBuffer = [
        ...this.priceDataBuffer,
        // Only keep the newest data points if buffer exceeds double the max size
        ...((this.priceDataBuffer.length > this.maxBufferSize * 2) 
            ? this.priceDataBuffer.slice(-this.maxBufferSize) 
            : this.priceDataBuffer)
      ];
      
      this.recordDbError('flushPriceDataBuffer', error, false);
    }
  }
  
  /**
   * Purge old price data to manage database size
   * @param days Number of days of data to keep, defaults to dataRetentionDays
   */
  public async purgeOldPriceData(days: number = this.dataRetentionDays): Promise<void> {
    try {
      const cutoffTimestamp = Math.floor(Date.now() / 1000) - (days * 24 * 60 * 60);
      
      // Since deleteOldPriceData doesn't exist, implement the deletion logic here
      // We'll use a generic method if available, or log that this functionality needs implementation
      console.log(`Data purge functionality needs implementation for data older than ${days} days`);
      // TODO: Implement data retention logic when DatabaseService supports it
      const deletedCount = 0; // Placeholder
      
      if (deletedCount > 0) {
        console.log(`Purged ${deletedCount} price data records older than ${days} days`);
      }
    } catch (error) {
      console.error('Error purging old price data:', error);
      this.recordDbError('purgeOldPriceData', error, false);
    }
  }
  
  /**
   * Record a position creation event
   * @param tokenId Position token ID
   * @param position Position details with required tracking data
   * @throws Will throw an error for critical database failures if throwOnCritical is true
   */
  public async recordPositionCreated(
    tokenId: number, 
    position: TrackablePositionData, 
    throwOnCritical: boolean = false
  ): Promise<void> {
    try {
      // Save position to database
      await this.dbService.savePosition({
        ...position,
        tokenId,
        isActive: true // Explicitly mark position as active
      } as PositionInfo);
      
      // Record action
      await this.recordAction({
        type: ActionType.POSITION_CREATED,
        tokenId,
        data: {
          tickLower: position.tickLower,
          tickUpper: position.tickUpper,
          priceLower: position.priceLower,
          priceUpper: position.priceUpper
        },
        token0Amount: position.amount0 || position.token0Amount,
        token1Amount: position.amount1 || position.token1Amount
      }, `position creation: ID ${tokenId}`, true); // Critical operation
      
      // Update success metrics
      this.lastSuccessfulOperation = Math.floor(Date.now() / 1000);
      this.consecutiveFailures = 0;
    } catch (error) {
      const errorMessage = `Error recording position creation: ${error}`;
      console.error(errorMessage);
      
      // Record the database error - creating a position is critical
      this.recordDbError('recordPositionCreated', error, true);
      
      // Propagate error if configured to do so for critical operations
      if (throwOnCritical) {
        throw new Error(errorMessage);
      }
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
      await this.recordAction({
        type: ActionType.POSITION_CREATION_FAILED,
        data: {
          positionType,
          error: this.formatErrorMessage(error),
          ...tickData
        }
      }, `position creation failure for ${positionType} position`, true); // Critical operation
      
      // Update success metrics
      this.lastSuccessfulOperation = Math.floor(Date.now() / 1000);
      this.consecutiveFailures = 0;
    } catch (dbError) {
      console.error(`Error recording position creation failure: ${dbError}`);
      this.recordDbError('recordPositionCreationFailed', dbError, true);
    }
  }
  
  /**
   * Record a position closed event
   * @param tokenId Position token ID
   * @param amount0 Amount of token0 received
   * @param amount1 Amount of token1 received
   * @param throwOnCritical Whether to throw an error for critical database failures
   */
  public async recordPositionClosed(
    tokenId: number, 
    amount0: ethers.BigNumber, 
    amount1: ethers.BigNumber,
    throwOnCritical: boolean = false
  ): Promise<void> {
    try {
      // Get the position from database
      const position = await this.dbService.getPosition(tokenId.toString());
      
      if (position) {
        // Update position as inactive
        position.isActive = false;
        await this.dbService.savePosition(position);
      }
      
      // Record action
      await this.recordAction({
        type: ActionType.POSITION_CLOSED,
        tokenId,
        token0Amount: amount0,
        token1Amount: amount1
      }, `position closure: ID ${tokenId}`, true); // Critical operation
      
      // Update success metrics
      this.lastSuccessfulOperation = Math.floor(Date.now() / 1000);
      this.consecutiveFailures = 0;
    } catch (error) {
      const errorMessage = `Error recording position closure: ${error}`;
      console.error(errorMessage);
      
      // Record the database error - closing a position is critical
      this.recordDbError('recordPositionClosed', error, true);
      
      // Propagate error if configured to do so for critical operations
      if (throwOnCritical) {
        throw new Error(errorMessage);
      }
    }
  }

  /**
   * Record a position close failure
   * @param tokenId Position token ID
   * @param error Error message or object
   */
  public async recordPositionCloseFailed(tokenId: number, error: any): Promise<void> {
    try {
      await this.recordAction({
        type: ActionType.POSITION_CLOSE_FAILED,
        tokenId,
        data: {
          error: this.formatErrorMessage(error)
        }
      }, `position close failure for ID ${tokenId}`, true); // Critical operation
      
      // Update success metrics
      this.lastSuccessfulOperation = Math.floor(Date.now() / 1000);
      this.consecutiveFailures = 0;
    } catch (dbError) {
      console.error(`Error recording position close failure: ${dbError}`);
      this.recordDbError('recordPositionCloseFailed', dbError, true);
    }
  }

  /**
   * Record a stray position detected event
   * @param tokenId Position token ID
   * @param position Position details with minimal required data
   */
  public async recordStrayPositionDetected(tokenId: number, position: StrayPositionData): Promise<void> {
    try {
      await this.recordAction({
        type: ActionType.STRAY_POSITION_DETECTED,
        tokenId,
        data: {
          tickLower: position.tickLower,
          tickUpper: position.tickUpper,
          liquidity: position.liquidity.toString()
        }
      }, `stray position detection: ID ${tokenId}`, true); // Critical for tracking
      
      // Update success metrics
      this.lastSuccessfulOperation = Math.floor(Date.now() / 1000);
      this.consecutiveFailures = 0;
    } catch (error) {
      console.error(`Error recording stray position detection: ${error}`);
      this.recordDbError('recordStrayPositionDetected', error, true);
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
      await this.recordAction({
        type: ActionType.STRAY_POSITION_CLOSED,
        tokenId,
        token0Amount: amount0,
        token1Amount: amount1
      }, `stray position closure: ID ${tokenId}`, true); // Critical for tracking
      
      // Update success metrics
      this.lastSuccessfulOperation = Math.floor(Date.now() / 1000);
      this.consecutiveFailures = 0;
    } catch (error) {
      console.error(`Error recording stray position closure: ${error}`);
      this.recordDbError('recordStrayPositionClosed', error, true);
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
      // Convert amount to string for storage
      let amountString: string;
      if (typeof amount === 'number') {
        amountString = amount.toString();
      } else {
        // If it's a BigNumber, format it
        amountString = amount.toString();
      }
      
      await this.recordAction({
        type: ActionType.SWAP_FAILED,
        data: {
          fromToken,
          toToken,
          amount: amountString,
          error: this.formatErrorMessage(error)
        }
      }, `swap failure: ${fromToken} -> ${toToken}`, true); // Critical for tracking
      
      // Update success metrics
      this.lastSuccessfulOperation = Math.floor(Date.now() / 1000);
      this.consecutiveFailures = 0;
    } catch (dbError) {
      console.error(`Error recording swap failure: ${dbError}`);
      this.recordDbError('recordSwapFailed', dbError, true);
    }
  }

  /**
   * Record a rebalance failure
   * @param reason Reason for rebalance failure
   * @param error Error message or object
   */
  public async recordRebalanceFailed(reason: string, error: any): Promise<void> {
    try {
      await this.recordAction({
        type: ActionType.REBALANCE_FAILED,
        data: {
          reason,
          error: this.formatErrorMessage(error)
        }
      }, `rebalance failure: ${reason}`, true); // Critical for strategy monitoring
      
      // Update success metrics
      this.lastSuccessfulOperation = Math.floor(Date.now() / 1000);
      this.consecutiveFailures = 0;
    } catch (dbError) {
      console.error(`Error recording rebalance failure: ${dbError}`);
      this.recordDbError('recordRebalanceFailed', dbError, true);
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
      await this.recordAction({
        type: ActionType.STRATEGY_ERROR,
        data: {
          component,
          error: this.formatErrorMessage(error),
          ...additionalData
        }
      }, `strategy error in ${component}`, true); // Critical for strategy monitoring
      
      // Update success metrics
      this.lastSuccessfulOperation = Math.floor(Date.now() / 1000);
      this.consecutiveFailures = 0;
    } catch (dbError) {
      console.error(`Error recording strategy error: ${dbError}`);
      this.recordDbError('recordStrategyError', dbError, true);
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
      await this.recordAction({
        type: ActionType.FEES_COLLECTED,
        tokenId,
        token0Amount: amount0,
        token1Amount: amount1
      }, `fees collection: ID ${tokenId}`, false); // Non-critical operation
      
      // Update success metrics
      this.lastSuccessfulOperation = Math.floor(Date.now() / 1000);
      this.consecutiveFailures = 0;
    } catch (error) {
      console.error(`Error recording fees collection: ${error}`);
      this.recordDbError('recordFeesCollected', error, false);
    }
  }
  
  /**
   * Helper method to format error messages consistently
   * @param error Error object or message
   * @returns Formatted error message as string
   */
  private formatErrorMessage(error: any): string {
    return error instanceof Error ? error.message : String(error);
  }
  
  /**
   * Private helper method to standardize action recording
   * @param actionData Action data to record
   * @param logMessage Message to log on success (without the "Recorded " prefix)
   * @param isCritical Whether this is a critical operation for strategy functioning
   */
  private async recordAction(
    actionData: Omit<ActionEvent, 'timestamp'>, 
    logMessage: string,
    isCritical: boolean = false
  ): Promise<void> {
    try {
      // Add the timestamp
      const actionWithTimestamp: ActionEvent = {
        ...actionData,
        timestamp: Math.floor(Date.now() / 1000)
      };
      
      // Record the action
      await this.dbService.recordAction(actionWithTimestamp);
      
      // Log success
      console.log(`Recorded ${logMessage}`);
      
      // Update success metrics
      this.lastSuccessfulOperation = Math.floor(Date.now() / 1000);
      this.consecutiveFailures = 0;
    } catch (error) {
      // Log the error
      console.error(`Error recording ${logMessage}:`, error);
      
      // Track the error
      this.recordDbError('recordAction', error, isCritical);
      
      // Re-throw critical errors
      if (isCritical) {
        throw error;
      }
    }
  }
  
  /**
   * Records a database error and updates error metrics
   * @param operation The operation that failed
   * @param error The error that occurred
   * @param isCritical Whether this is a critical operation
   */
  private recordDbError(operation: string, error: any, isCritical: boolean): void {
    const timestamp = Math.floor(Date.now() / 1000);
    const errorMessage = this.formatErrorMessage(error);
    
    // Create error info
    const errorInfo: DbErrorInfo = {
      operation,
      timestamp,
      error: errorMessage,
      isCritical
    };
    
    // Update metrics
    this.failedOperations++;
    this.consecutiveFailures++;
    if (isCritical) {
      this.criticalFailures++;
    }
    
    // Add to error log with limit
    this.dbErrors.push(errorInfo);
    if (this.dbErrors.length > this.maxStoredErrors) {
      this.dbErrors.shift(); // Remove oldest error
    }
    
    // Emit events
    this.emit(TrackingServiceEvent.DB_ERROR, errorInfo);
    if (isCritical) {
      this.emit(TrackingServiceEvent.CRITICAL_ERROR, errorInfo);
    }
  }
  
  /**
   * Get the current health status of the database connection
   * @returns Database health status
   */
  public getDbHealthStatus(): DbHealthStatus {
    return {
      isConnected: this.isConnected,
      lastSuccessfulOperation: this.lastSuccessfulOperation,
      failedOperations: this.failedOperations,
      consecutiveFailures: this.consecutiveFailures,
      criticalFailures: this.criticalFailures,
      errors: [...this.dbErrors] // Return a copy to prevent external modification
    };
  }
  
  /**
   * Check if the database connection is healthy
   * @returns True if the database connection is healthy, false otherwise
   */
  public isDatabaseHealthy(): boolean {
    // Consider the database unhealthy if:
    // 1. We're not connected
    // 2. We've had 3+ consecutive failures
    // 3. It's been more than 5 minutes since the last successful operation
    const currentTime = Math.floor(Date.now() / 1000);
    const timeSinceLastSuccess = currentTime - this.lastSuccessfulOperation;
    
    return this.isConnected && 
           this.consecutiveFailures < 3 && 
           (this.lastSuccessfulOperation === 0 || timeSinceLastSuccess < 300);
  }
  
  /**
   * Reset error counters after recovery
   */
  public resetErrorCounters(): void {
    this.consecutiveFailures = 0;
    this.emit(TrackingServiceEvent.CONNECTION_RESTORED, {
      timestamp: Math.floor(Date.now() / 1000)
    });
  }
  
  /**
   * Test database connection and reset status if connection is restored
   * @returns True if the connection is active, false otherwise
   */
  public async testConnection(): Promise<boolean> {
    try {
      // Try to connect if not already connected
      if (!this.isConnected) {
        await this.dbService.connect();
      }
      
      // Try a simple read operation
      await this.dbService.getRecentActions(1);
      
      // If we got here, the connection is working
      this.isConnected = true;
      this.lastSuccessfulOperation = Math.floor(Date.now() / 1000);
      
      // If we had consecutive failures before, but now it's working, emit restore event
      if (this.consecutiveFailures > 0) {
        this.resetErrorCounters();
      }
      
      return true;
    } catch (error) {
      this.isConnected = false;
      this.recordDbError('testConnection', error, false);
      return false;
    }
  }
  
  /**
   * Get recent price history
   * @param limit Number of entries to return
   * @returns Recent price data
   */
  public async getPriceHistory(limit: number = 100): Promise<any[]> {
    try {
      const prices = await this.dbService.getRecentPrices(limit);
      this.lastSuccessfulOperation = Math.floor(Date.now() / 1000);
      this.consecutiveFailures = 0;
      return prices;
    } catch (error) {
      this.recordDbError('getPriceHistory', error, false);
      return []; // Return empty array on error
    }
  }
  
  /**
   * Get recent actions
   * @param limit Number of entries to return
   * @returns Recent action events
   */
  public async getRecentActions(limit: number = 50): Promise<ActionEvent[]> {
    try {
      const actions = await this.dbService.getRecentActions(limit);
      this.lastSuccessfulOperation = Math.floor(Date.now() / 1000);
      this.consecutiveFailures = 0;
      return actions;
    } catch (error) {
      this.recordDbError('getRecentActions', error, false);
      return []; // Return empty array on error
    }
  }
  
  /**
   * Cleanup and close connections
   */
  public async shutdown(): Promise<void> {
    this.stopTracking();
    try {
      await this.dbService.disconnect();
      console.log('DataTrackingService shutdown complete');
    } catch (error) {
      console.error('Error during DataTrackingService shutdown:', error);
    } finally {
      this.isConnected = false;
    }
  }

  /**
   * Save strategy stats to database
   * @param stats Strategy stats to save
   * @param throwOnCritical Whether to throw an error if saving fails
   */
  public async saveStrategyStats(stats: StrategyStats, throwOnCritical: boolean = false): Promise<void> {
    try {
      await this.dbService.saveStats(stats);
      console.log('Strategy stats saved to database');
      
      // Update success metrics
      this.lastSuccessfulOperation = Math.floor(Date.now() / 1000);
      this.consecutiveFailures = 0;
    } catch (error) {
      const errorMessage = `Error saving strategy stats: ${error}`;
      console.error(errorMessage);
      
      // Record the database error - strategy stats are important but maybe not critical
      this.recordDbError('saveStrategyStats', error, throwOnCritical);
      
      // Propagate error if configured to do so
      if (throwOnCritical) {
        throw new Error(errorMessage);
      }
    }
  }
} 