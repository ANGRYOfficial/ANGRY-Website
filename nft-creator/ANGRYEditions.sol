// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract ANGRYEditions {
    string public name;
    string public symbol;

    uint256 public constant TOKEN_ID = 1;

    uint256 public immutable maxSupply;
    uint256 public mintedSupply;

    uint256 public mintPrice;
    uint256 public maxPerWallet;

    address public owner;

    string private _tokenUri;

    address public royaltyReceiver;
    uint96 public royaltyBps;

    mapping(uint256 => mapping(address => uint256)) private _balances;
    mapping(address => mapping(address => bool)) private _operatorApprovals;

    // Counts NFTs originally minted by each wallet.
    // Transfers do not reset the wallet mint limit.
    mapping(address => uint256) public mintedByWallet;

    event TransferSingle(
        address indexed operator,
        address indexed from,
        address indexed to,
        uint256 id,
        uint256 value
    );

    event ApprovalForAll(
        address indexed account,
        address indexed operator,
        bool approved
    );

    event PublicMint(
        address indexed buyer,
        uint256 quantity,
        uint256 paid
    );

    event Withdrawal(
        address indexed recipient,
        uint256 amount
    );

    modifier onlyOwner() {
        require(msg.sender == owner, "NOT_OWNER");
        _;
    }

    constructor(
        string memory collectionName,
        string memory collectionSymbol,
        address initialOwner,
        string memory metadataUri,
        uint256 initialMaxSupply,
        uint256 initialMintPrice,
        uint256 initialMaxPerWallet,
        address initialRoyaltyReceiver,
        uint96 initialRoyaltyBps
    ) {
        require(initialOwner != address(0), "ZERO_OWNER");
        require(bytes(metadataUri).length != 0, "EMPTY_URI");

        require(initialMaxSupply >= 2, "SUPPLY_TOO_LOW");
        require(initialMaxSupply <= 10000, "SUPPLY_TOO_HIGH");

        require(initialMaxPerWallet >= 1, "MAX_WALLET_TOO_LOW");
        require(
            initialMaxPerWallet <= initialMaxSupply,
            "MAX_WALLET_TOO_HIGH"
        );

        require(initialRoyaltyBps <= 1000, "ROYALTY_TOO_HIGH");

        name = collectionName;
        symbol = collectionSymbol;

        owner = initialOwner;

        maxSupply = initialMaxSupply;
        mintPrice = initialMintPrice;
        maxPerWallet = initialMaxPerWallet;

        _tokenUri = metadataUri;

        royaltyReceiver =
            initialRoyaltyReceiver == address(0)
                ? initialOwner
                : initialRoyaltyReceiver;

        royaltyBps = initialRoyaltyBps;
    }

    function publicMint(uint256 quantity) external payable {
        require(quantity >= 1, "ZERO_QUANTITY");

        require(
            mintedSupply + quantity <= maxSupply,
            "MAX_SUPPLY_EXCEEDED"
        );

        require(
            mintedByWallet[msg.sender] + quantity <= maxPerWallet,
            "MAX_PER_WALLET_EXCEEDED"
        );

        uint256 requiredPayment = mintPrice * quantity;

        require(msg.value == requiredPayment, "WRONG_PAYMENT");

        // State is updated before any receiver callback.
        mintedSupply += quantity;
        mintedByWallet[msg.sender] += quantity;
        _balances[TOKEN_ID][msg.sender] += quantity;

        emit TransferSingle(
            msg.sender,
            address(0),
            msg.sender,
            TOKEN_ID,
            quantity
        );

        emit PublicMint(
            msg.sender,
            quantity,
            msg.value
        );

        if (msg.sender.code.length != 0) {
            (bool ok, bytes memory result) = msg.sender.call(
                abi.encodeWithSelector(
                    bytes4(
                        keccak256(
                            "onERC1155Received(address,address,uint256,uint256,bytes)"
                        )
                    ),
                    msg.sender,
                    address(0),
                    TOKEN_ID,
                    quantity,
                    ""
                )
            );

            require(
                ok &&
                result.length >= 32 &&
                abi.decode(result, (bytes4)) == 0xf23a6e61,
                "UNSAFE_RECIPIENT"
            );
        }
    }

    function withdraw() external onlyOwner {
        uint256 amount = address(this).balance;

        require(amount > 0, "NO_BALANCE");

        (bool ok, ) = payable(owner).call{value: amount}("");

        require(ok, "WITHDRAW_FAILED");

        emit Withdrawal(owner, amount);
    }

    function remainingSupply()
        external
        view
        returns (uint256)
    {
        return maxSupply - mintedSupply;
    }

    function supportsInterface(bytes4 interfaceId)
        external
        pure
        returns (bool)
    {
        return
            interfaceId == 0x01ffc9a7 || // ERC-165
            interfaceId == 0xd9b67a26 || // ERC-1155
            interfaceId == 0x0e89341c || // ERC-1155 Metadata URI
            interfaceId == 0x2a55205a;   // ERC-2981
    }

    function balanceOf(address account, uint256 id)
        public
        view
        returns (uint256)
    {
        require(account != address(0), "ZERO_ADDRESS");
        require(id == TOKEN_ID, "INVALID_TOKEN_ID");

        return _balances[id][account];
    }

    function balanceOfBatch(
        address[] calldata accounts,
        uint256[] calldata ids
    )
        external
        view
        returns (uint256[] memory values)
    {
        require(accounts.length == ids.length, "LENGTH_MISMATCH");

        values = new uint256[](accounts.length);

        for (uint256 i = 0; i < accounts.length; i++) {
            values[i] = balanceOf(accounts[i], ids[i]);
        }
    }

    function uri(uint256 id)
        external
        view
        returns (string memory)
    {
        require(id == TOKEN_ID, "INVALID_TOKEN_ID");

        return _tokenUri;
    }

    function setApprovalForAll(
        address operator,
        bool approved
    )
        external
    {
        require(operator != msg.sender, "SELF_APPROVAL");

        _operatorApprovals[msg.sender][operator] = approved;

        emit ApprovalForAll(
            msg.sender,
            operator,
            approved
        );
    }

    function isApprovedForAll(
        address account,
        address operator
    )
        external
        view
        returns (bool)
    {
        return _operatorApprovals[account][operator];
    }

    function safeTransferFrom(
        address from,
        address to,
        uint256 id,
        uint256 amount,
        bytes calldata data
    )
        external
    {
        require(
            msg.sender == from ||
            _operatorApprovals[from][msg.sender],
            "NOT_AUTHORIZED"
        );

        _safeTransferFrom(
            from,
            to,
            id,
            amount,
            data
        );
    }

    function safeBatchTransferFrom(
        address from,
        address to,
        uint256[] calldata ids,
        uint256[] calldata amounts,
        bytes calldata data
    )
        external
    {
        require(
            msg.sender == from ||
            _operatorApprovals[from][msg.sender],
            "NOT_AUTHORIZED"
        );

        require(
            ids.length == amounts.length,
            "LENGTH_MISMATCH"
        );

        require(to != address(0), "ZERO_RECIPIENT");

        for (uint256 i = 0; i < ids.length; i++) {
            _transferBalance(
                from,
                to,
                ids[i],
                amounts[i]
            );
        }

        emit TransferSingle(
            msg.sender,
            from,
            to,
            TOKEN_ID,
            amounts.length
        );

        if (to.code.length != 0) {
            (bool ok, bytes memory result) = to.call(
                abi.encodeWithSelector(
                    bytes4(
                        keccak256(
                            "onERC1155BatchReceived(address,address,uint256[],uint256[],bytes)"
                        )
                    ),
                    msg.sender,
                    from,
                    ids,
                    amounts,
                    data
                )
            );

            require(
                ok &&
                result.length >= 32 &&
                abi.decode(result, (bytes4)) == 0xbc197c81,
                "UNSAFE_RECIPIENT"
            );
        }
    }

    function _safeTransferFrom(
        address from,
        address to,
        uint256 id,
        uint256 amount,
        bytes calldata data
    )
        internal
    {
        require(to != address(0), "ZERO_RECIPIENT");

        _transferBalance(
            from,
            to,
            id,
            amount
        );

        emit TransferSingle(
            msg.sender,
            from,
            to,
            id,
            amount
        );

        if (to.code.length != 0) {
            (bool ok, bytes memory result) = to.call(
                abi.encodeWithSelector(
                    bytes4(
                        keccak256(
                            "onERC1155Received(address,address,uint256,uint256,bytes)"
                        )
                    ),
                    msg.sender,
                    from,
                    id,
                    amount,
                    data
                )
            );

            require(
                ok &&
                result.length >= 32 &&
                abi.decode(result, (bytes4)) == 0xf23a6e61,
                "UNSAFE_RECIPIENT"
            );
        }
    }

    function _transferBalance(
        address from,
        address to,
        uint256 id,
        uint256 amount
    )
        internal
    {
        require(id == TOKEN_ID, "INVALID_TOKEN_ID");

        uint256 fromBalance = _balances[id][from];

        require(
            fromBalance >= amount,
            "INSUFFICIENT_BALANCE"
        );

        unchecked {
            _balances[id][from] =
                fromBalance - amount;
        }

        _balances[id][to] += amount;
    }

    function royaltyInfo(
        uint256 tokenId,
        uint256 salePrice
    )
        external
        view
        returns (
            address,
            uint256
        )
    {
        require(
            tokenId == TOKEN_ID,
            "INVALID_TOKEN_ID"
        );

        return (
            royaltyReceiver,
            (salePrice * royaltyBps) / 10000
        );
    }
}
