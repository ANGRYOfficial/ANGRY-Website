# ANGRY Liquidity Token Guide

ANGRY Token Creator is designed to make token creation simple.

Developers do not need to write Solidity code or manually configure routers, factories, thresholds or other technical contract settings.

## Simple Flow

1. Choose **Liquidity Token** in ANGRY Token Creator.
2. Enter token name, symbol, total supply and fee settings.
3. Create the token.
4. The full token supply is sent to the developer wallet.
5. Create the first TOKEN / ETH liquidity pool on the supported DEX.
6. After the initial pool exists, Auto Liquidity works automatically.

## Ethereum

Supported Auto Liquidity DEX:

**Ethereum → Uniswap V2**

The developer creates the initial TOKEN / ETH liquidity pool once.

After that, the token contract can automatically collect the selected Auto Liquidity fee from token transactions.

When the Auto Liquidity reserve reaches the contract threshold, the contract processes part of the reserve and adds TOKEN + ETH back into the existing Uniswap V2 liquidity pool.

The LP tokens created by automatic liquidity additions are sent to the creator / project wallet.

## Fee Options

### Holder Reflection

A percentage of token transactions is distributed automatically to eligible token holders.

### Auto Liquidity

A percentage of token transactions is reserved for automatic liquidity.

Auto Liquidity only starts after the developer creates the first supported liquidity pool.

### Project / Creator

A percentage of token transactions is sent automatically to the creator / project wallet.

### Burn

A percentage of token transactions is permanently removed from the total token supply.

## Important

ANGRY does not hold developer funds or liquidity.

ANGRY only provides the interface and smart contract used to create the token.

Initial liquidity is supplied directly by the developer through the supported DEX.

Every blockchain transaction still requires confirmation from the developer wallet.

If Auto Liquidity is set to 0%, the Auto Liquidity feature is disabled.

## Current Tested Status

Ethereum Auto Liquidity has been successfully tested on Ethereum Sepolia with Uniswap V2.

Other networks should only be documented as supported after their own contract and DEX integration tests are completed.
