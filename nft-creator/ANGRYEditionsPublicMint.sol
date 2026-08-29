// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC1155/extensions/ERC1155Supply.sol";
import "@openzeppelin/contracts/token/common/ERC2981.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract ANGRYEditionsPublicMint is
    ERC1155Supply,
    ERC2981,
    Ownable,
    ReentrancyGuard
{
    uint256 public constant TOKEN_ID = 1;

    string public name;
    string public symbol;

    uint256 public immutable maxSupply;
    uint256 public immutable mintPrice;

    // 0 = unlimited
    uint256 public immutable maxPerWallet;

    address payable public immutable payoutWallet;

    mapping(address => uint256) public mintedByWallet;

    event PublicMint(
        address indexed wallet,
        uint256 quantity,
        uint256 amountPaid
    );

    event FundsWithdrawn(
        address indexed wallet,
        uint256 amount
    );

    constructor(
        string memory collectionName_,
        string memory collectionSymbol_,
        string memory metadataUri_,
        uint256 maxSupply_,
        uint256 mintPriceWei_,
        uint256 maxPerWallet_,
        address royaltyRecipient_,
        uint96 royaltyBps_
    )
        ERC1155(metadataUri_)
        Ownable(msg.sender)
    {
        require(
            bytes(collectionName_).length > 0,
            "NAME_REQUIRED"
        );

        require(
            bytes(collectionSymbol_).length > 0,
            "SYMBOL_REQUIRED"
        );

        require(
            bytes(metadataUri_).length > 0,
            "URI_REQUIRED"
        );

        require(
            maxSupply_ >= 2 &&
            maxSupply_ <= 10000,
            "INVALID_SUPPLY"
        );

        require(
            maxPerWallet_ == 0 ||
            maxPerWallet_ <= maxSupply_,
            "INVALID_WALLET_LIMIT"
        );

        require(
            royaltyBps_ <= 1000,
            "ROYALTY_TOO_HIGH"
        );

        name = collectionName_;
        symbol = collectionSymbol_;

        maxSupply = maxSupply_;
        mintPrice = mintPriceWei_;
        maxPerWallet = maxPerWallet_;

        payoutWallet = payable(msg.sender);

        if (royaltyBps_ > 0) {
            require(
                royaltyRecipient_ != address(0),
                "ROYALTY_RECIPIENT_REQUIRED"
            );

            _setDefaultRoyalty(
                royaltyRecipient_,
                royaltyBps_
            );
        }
    }

    function publicMint(uint256 quantity)
        external
        payable
        nonReentrant
    {
        require(
            quantity > 0,
            "QUANTITY_REQUIRED"
        );

        require(
            totalSupply(TOKEN_ID) + quantity <= maxSupply,
            "MAX_SUPPLY_REACHED"
        );

        if (maxPerWallet > 0) {
            require(
                mintedByWallet[msg.sender] + quantity
                    <= maxPerWallet,
                "WALLET_LIMIT_REACHED"
            );
        }

        uint256 requiredPayment =
            mintPrice * quantity;

        require(
            msg.value == requiredPayment,
            "WRONG_PAYMENT"
        );

        mintedByWallet[msg.sender] += quantity;

        _mint(
            msg.sender,
            TOKEN_ID,
            quantity,
            ""
        );

        emit PublicMint(
            msg.sender,
            quantity,
            msg.value
        );
    }

    function remainingSupply()
        external
        view
        returns (uint256)
    {
        return
            maxSupply -
            totalSupply(TOKEN_ID);
    }

    function withdraw()
        external
        onlyOwner
        nonReentrant
    {
        uint256 amount =
            address(this).balance;

        require(
            amount > 0,
            "NO_FUNDS"
        );

        (bool success, ) =
            payoutWallet.call{
                value: amount
            }("");

        require(
            success,
            "WITHDRAW_FAILED"
        );

        emit FundsWithdrawn(
            payoutWallet,
            amount
        );
    }

    function supportsInterface(
        bytes4 interfaceId
    )
        public
        view
        override(ERC1155, ERC2981)
        returns (bool)
    {
        return
            super.supportsInterface(
                interfaceId
            );
    }
}
