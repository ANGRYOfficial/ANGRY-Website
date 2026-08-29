# ANGRY Auto Liquidity

ANGRY Token Creator stays simple: create the token, receive the full supply in the developer wallet, then create the first liquidity pool yourself on the supported DEX.

## Ethereum

- Ethereum Mainnet: Uniswap V2
- Ethereum Sepolia: Uniswap V2

## Flow

1. Create the token in ANGRY.
2. The full token supply is sent to the deployer wallet.
3. Create the initial TOKEN/ETH liquidity pool on the supported DEX.
4. After that pool has real liquidity, the Auto Liquidity fee starts being collected.
5. When the internal threshold is reached, the token contract swaps part of the collected tokens for ETH.
6. The contract combines TOKEN + ETH and adds them to the existing pool automatically.
7. LP tokens created by the automatic process are sent to the Project / Creator wallet.

ANGRY does not custody the developer's initial liquidity or LP tokens.

## Important

Auto Liquidity does not create the first pool. The developer must create the initial pool once.

The Ethereum build recognizes only the supported Uniswap V2 deployment for the current Ethereum network. Technical Router / Factory / WETH details are intentionally kept out of the Token Creator UI.
