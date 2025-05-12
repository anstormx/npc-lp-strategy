import { MongoClient, Collection } from 'mongodb';
import { 
  PriceData, 
  DbPositionInfo, 
  DbActionEvent, 
  PositionInfo, 
  ActionEvent, 
  StrategyStats, 
  DbStrategyStats
} from '../utils/types';
import { BigNumber } from 'ethers';

/**
 * Database service for storing strategy data in MongoDB
 */
export class DatabaseService {
  private client: MongoClient;
  private connected: boolean = false;
  private dbName: string;
  private priceCollection: Collection | null = null;
  private positionCollection: Collection | null = null;
  private actionCollection: Collection | null = null;
  private statsCollection: Collection | null = null;

  constructor(mongoUri: string, dbName: string) {
    // Add connection options to handle connection issues
    const connectOptions = {
      serverSelectionTimeoutMS: 5000, // Timeout after 5 seconds
      socketTimeoutMS: 30000, // Timeout after 30 seconds
      connectTimeoutMS: 10000, // Connection timeout after 10 seconds
      retryWrites: true,
      retryReads: true,
      maxPoolSize: 10
    };
    
    this.client = new MongoClient(mongoUri, connectOptions);
    this.dbName = dbName;
  }

  /**
   * Connect to MongoDB
   */
  public async connect(): Promise<void> {
    if (this.connected) return;

    try {
      // Try to connect with options
      await this.client.connect();
      console.log('Connected to MongoDB');
      
      // Initialize database and collections
      const db = this.client.db(this.dbName);
      
      // Create collections if they don't exist
      const collections = await db.listCollections().toArray();
      const collectionNames = collections.map(col => col.name);
      
      if (!collectionNames.includes('prices')) {
        await db.createCollection('prices');
        console.log('Created prices collection');
      }
      
      if (!collectionNames.includes('positions')) {
        await db.createCollection('positions');
        console.log('Created positions collection');
      }
      
      if (!collectionNames.includes('actions')) {
        await db.createCollection('actions');
        console.log('Created actions collection');
      }
      
      if (!collectionNames.includes('stats')) {
        await db.createCollection('stats');
        console.log('Created stats collection');
      }
      
      // Get collection references
      this.priceCollection = db.collection('prices');
      this.positionCollection = db.collection('positions');
      this.actionCollection = db.collection('actions');
      this.statsCollection = db.collection('stats');
      
      // Create indexes
      await this.priceCollection.createIndex({ timestamp: 1 });
      await this.positionCollection.createIndex({ tokenId: 1 }, { unique: true });
      await this.actionCollection.createIndex({ timestamp: 1 });
      
      this.connected = true;
      console.log(`Connected to MongoDB database: ${this.dbName}`);
    } catch (error: any) {
      console.error('Error connecting to MongoDB:', error);
      throw new Error(`MongoDB connection failed. Make sure MongoDB is running at the URI specified in your .env file. Error: ${error.message}`);
    }
  }

  /**
   * Disconnect from MongoDB
   */
  public async disconnect(): Promise<void> {
    if (!this.connected) return;

    try {
      await this.client.close();
      console.log('Disconnected from MongoDB');
      this.connected = false;
    } catch (error) {
      console.error('Error disconnecting from MongoDB:', error);
    }
  }

  /**
   * Save price data to the database
   * @param priceData Price data to save
   */
  public async savePriceData(priceData: PriceData): Promise<void> {
    if (!this.connected || !this.priceCollection) {
      await this.connect();
    }

    try {
      await this.priceCollection!.insertOne({
        ...priceData,
        createdAt: new Date()
      });
    } catch (error) {
      console.error('Error saving price data:', error);
    }
  }

  /**
   * Convert PositionInfo to DbPositionInfo for MongoDB storage
   * @param position Position info to convert
   * @returns MongoDB compatible position info
   */
  private convertPositionForDb(position: PositionInfo): DbPositionInfo {
    const dbPosition: DbPositionInfo = {
      tickLower: position.tickLower,
      tickUpper: position.tickUpper,
      liquidity: position.liquidity.toString(),
      amount0: position.amount0.toString(),
      amount1: position.amount1.toString(),
      inRange: position.inRange
    };
    
    // Add optional fields if they exist
    if (position.tokenId !== undefined) {
      dbPosition.tokenId = position.tokenId;
    }
    
    if (position.token0Amount) {
      dbPosition.token0Amount = position.token0Amount.toString();
    }
    
    if (position.token1Amount) {
      dbPosition.token1Amount = position.token1Amount.toString();
    }
    
    if (position.feeGrowthInside0LastX128) {
      dbPosition.feeGrowthInside0 = position.feeGrowthInside0LastX128.toString();
    }
    
    if (position.feeGrowthInside1LastX128) {
      dbPosition.feeGrowthInside1 = position.feeGrowthInside1LastX128.toString();
    }
    
    if (position.priceLower !== undefined) {
      dbPosition.priceLower = position.priceLower;
    }
    
    if (position.priceUpper !== undefined) {
      dbPosition.priceUpper = position.priceUpper;
    }
    
    if (position.isActive !== undefined) {
      dbPosition.isActive = position.isActive;
    }
    
    return dbPosition;
  }

  /**
   * Convert ActionEvent to DbActionEvent for MongoDB storage
   * @param action Action event to convert
   * @returns MongoDB compatible action event
   */
  private convertActionForDb(action: ActionEvent): DbActionEvent {
    return {
      ...action,
      token0Amount: action.token0Amount?.toString(),
      token1Amount: action.token1Amount?.toString()
    };
  }

  /**
   * Convert StrategyStats to DbStrategyStats for MongoDB storage
   * @param stats Strategy stats to convert
   * @returns MongoDB compatible strategy stats
   */
  private convertStatsForDb(stats: StrategyStats): DbStrategyStats {
    return {
      ...stats,
      totalFeesCollectedToken0: stats.totalFeesCollectedToken0.toString(),
      totalFeesCollectedToken1: stats.totalFeesCollectedToken1.toString(),
      initialToken0Amount: stats.initialToken0Amount.toString(),
      initialToken1Amount: stats.initialToken1Amount.toString(),
      currentToken0Amount: stats.currentToken0Amount.toString(),
      currentToken1Amount: stats.currentToken1Amount.toString(),
      totalVolumeGenerated: stats.totalVolume.toString()
    };
  }

  /**
   * Convert DbPositionInfo back to PositionInfo
   * @param dbPosition Database position info
   * @returns Application position info
   */
  private convertPositionFromDb(dbPosition: DbPositionInfo): PositionInfo {
    const position: PositionInfo = {
      tickLower: dbPosition.tickLower,
      tickUpper: dbPosition.tickUpper,
      liquidity: BigNumber.from(dbPosition.liquidity),
      amount0: BigNumber.from(dbPosition.amount0),
      amount1: BigNumber.from(dbPosition.amount1),
      inRange: dbPosition.inRange
    };
    
    // Add optional fields if they exist
    if (dbPosition.tokenId !== undefined) {
      position.tokenId = dbPosition.tokenId;
    }
    
    if (dbPosition.token0Amount) {
      position.token0Amount = BigNumber.from(dbPosition.token0Amount);
    }
    
    if (dbPosition.token1Amount) {
      position.token1Amount = BigNumber.from(dbPosition.token1Amount);
    }
    
    if (dbPosition.feeGrowthInside0) {
      position.feeGrowthInside0LastX128 = BigNumber.from(dbPosition.feeGrowthInside0);
    }
    
    if (dbPosition.feeGrowthInside1) {
      position.feeGrowthInside1LastX128 = BigNumber.from(dbPosition.feeGrowthInside1);
    }
    
    if (dbPosition.priceLower !== undefined) {
      position.priceLower = dbPosition.priceLower;
    }
    
    if (dbPosition.priceUpper !== undefined) {
      position.priceUpper = dbPosition.priceUpper;
    }
    
    if (dbPosition.isActive !== undefined) {
      position.isActive = dbPosition.isActive;
    }
    
    return position;
  }

  /**
   * Save a position to the database
   * @param position Position to save
   */
  public async savePosition(position: PositionInfo): Promise<void> {
    if (!this.connected || !this.positionCollection) {
      await this.connect();
    }

    try {
      const dbPosition = this.convertPositionForDb(position);
      await this.positionCollection!.updateOne(
        { tokenId: position.tokenId },
        { $set: dbPosition },
        { upsert: true }
      );
    } catch (error) {
      console.error('Error saving position:', error);
    }
  }

  /**
   * Get a position by ID
   * @param tokenId Position ID to retrieve
   * @returns Position info or null if not found
   */
  public async getPosition(tokenId: string): Promise<PositionInfo | null> {
    if (!this.connected || !this.positionCollection) {
      await this.connect();
    }

    try {
      const dbPosition = await this.positionCollection!.findOne({ tokenId });
      if (!dbPosition) return null;
      return this.convertPositionFromDb(dbPosition as unknown as DbPositionInfo);
    } catch (error) {
      console.error('Error getting position:', error);
      return null;
    }
  }

  /**
   * Record an action event
   * @param action Action event to record
   */
  public async recordAction(action: ActionEvent): Promise<void> {
    if (!this.connected || !this.actionCollection) {
      await this.connect();
    }

    try {
      const dbAction = this.convertActionForDb(action);
      await this.actionCollection!.insertOne({
        ...dbAction,
        createdAt: new Date()
      });
    } catch (error) {
      console.error('Error recording action:', error);
    }
  }

  /**
   * Save strategy stats
   * @param stats Strategy stats to save
   */
  public async saveStats(stats: StrategyStats): Promise<void> {
    if (!this.connected || !this.statsCollection) {
      await this.connect();
    }

    try {
      const dbStats = this.convertStatsForDb(stats);
      await this.statsCollection!.updateOne(
        { startTimestamp: stats.startTimestamp },
        { $set: dbStats },
        { upsert: true }
      );
    } catch (error) {
      console.error('Error saving stats:', error);
    }
  }

  /**
   * Get latest strategy stats
   * @returns Latest strategy stats or null if not found
   */
  public async getLatestStats(): Promise<StrategyStats | null> {
    if (!this.connected || !this.statsCollection) {
      await this.connect();
    }

    try {
      const dbStats = await this.statsCollection!.findOne(
        {},
        { sort: { startTimestamp: -1 } }
      );
      
      if (!dbStats) return null;
      
      const statsWithBigNumbers = {
        ...dbStats,
        totalFeesCollectedToken0: BigNumber.from(dbStats.totalFeesCollectedToken0),
        totalFeesCollectedToken1: BigNumber.from(dbStats.totalFeesCollectedToken1),
        initialToken0Amount: BigNumber.from(dbStats.initialToken0Amount),
        initialToken1Amount: BigNumber.from(dbStats.initialToken1Amount),
        currentToken0Amount: BigNumber.from(dbStats.currentToken0Amount),
        currentToken1Amount: BigNumber.from(dbStats.currentToken1Amount),
        totalVolume: BigNumber.from(dbStats.totalVolumeGenerated)
      };
      
      return statsWithBigNumbers as unknown as StrategyStats;
    } catch (error) {
      console.error('Error getting latest stats:', error);
      return null;
    }
  }

  /**
   * Get recent price data
   * @param limit Number of entries to return
   * @returns Recent price data
   */
  public async getRecentPrices(limit: number = 100): Promise<PriceData[]> {
    if (!this.connected || !this.priceCollection) {
      await this.connect();
    }

    try {
      const prices = await this.priceCollection!.find({})
        .sort({ timestamp: -1 })
        .limit(limit)
        .toArray();
      return prices as unknown as PriceData[];
    } catch (error) {
      console.error('Error getting recent prices:', error);
      return [];
    }
  }

  /**
   * Get recent actions
   * @param limit Number of entries to return
   * @returns Recent action events
   */
  public async getRecentActions(limit: number = 50): Promise<ActionEvent[]> {
    if (!this.connected || !this.actionCollection) {
      await this.connect();
    }

    try {
      const dbActions = await this.actionCollection!.find({})
        .sort({ timestamp: -1 })
        .limit(limit)
        .toArray();
      
      return (dbActions as unknown as DbActionEvent[]).map(dbAction => ({
        ...dbAction,
        token0Amount: dbAction.token0Amount ? BigNumber.from(dbAction.token0Amount) : undefined,
        token1Amount: dbAction.token1Amount ? BigNumber.from(dbAction.token1Amount) : undefined
      })) as ActionEvent[];
    } catch (error) {
      console.error('Error getting recent actions:', error);
      return [];
    }
  }
} 