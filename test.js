const ethers = require('ethers');

const decodedData = ethers.utils.defaultAbiCoder.decode(
    ['uint128', 'uint256', 'uint256'],
    "0x000000000000000000000000000000000000000000000000000016b80d169acc000000000000000000000000000000000000000000000000000c6f3b40b6c06f0000000000000000000000000000000000000000000000000000000000000000"
);

const amount0 = decodedData[1];
const amount1 = decodedData[2];

console.log(`Liquidity decreased. Received: 
    Token0: ${ethers.utils.formatEther(amount0)} WETH
    Token1: ${ethers.utils.formatUnits(amount1, 6)} USDC
  `);