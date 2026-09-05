// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./BscLiquidityTokenPlatformFeeTest.sol";

contract AngryBscTokenFactoryTest {
    // TESTNET ONLY: 0.001 tBNB.
    uint256 public constant PLATFORM_FEE = 0.001 ether;

    address payable public immutable feeRecipient;

    event TokenCreated(
        address indexed creator,
        address indexed token,
        address indexed projectWallet,
        uint256 platformFee
    );

    constructor() {
        require(block.chainid == 97, "BSC Testnet only");
        feeRecipient = payable(msg.sender);
    }

    function createToken(
        string calldata name_,
        string calldata symbol_,
        uint256 supply_,
        address projectWallet_,
        uint16 holderFeeBps_,
        uint16 liquidityFeeBps_,
        uint16 projectFeeBps_,
        uint16 burnFeeBps_
    )
        external
        payable
        returns (address tokenAddress)
    {
        require(block.chainid == 97, "BSC Testnet only");
        require(
            msg.value == PLATFORM_FEE,
            "Incorrect platform fee"
        );

        AngryLiquidityTokenPlatformFeeTest token =
            new AngryLiquidityTokenPlatformFeeTest(
                name_,
                symbol_,
                supply_,
                projectWallet_,
                msg.sender,
                holderFeeBps_,
                liquidityFeeBps_,
                projectFeeBps_,
                burnFeeBps_
            );

        tokenAddress = address(token);

        // Fee is paid only if token creation succeeds.
        // If this payment fails, the entire transaction reverts.
        (bool paid, ) =
            feeRecipient.call{value: msg.value}("");

        require(paid, "Platform fee payment failed");

        emit TokenCreated(
            msg.sender,
            tokenAddress,
            projectWallet_,
            msg.value
        );
    }
}
