// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract ANGRYEditions {
    string public name;
    string public symbol;

    uint256 public constant TOKEN_ID = 1;
    uint256 public immutable totalSupply;

    string private _tokenUri;

    address public royaltyReceiver;
    uint96 public royaltyBps;

    mapping(uint256 => mapping(address => uint256)) private _balances;
    mapping(address => mapping(address => bool)) private _operatorApprovals;

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

    constructor(
        string memory collectionName,
        string memory collectionSymbol,
        address recipient,
        string memory metadataUri,
        uint256 initialSupply,
        address initialRoyaltyReceiver,
        uint96 initialRoyaltyBps
    ) {
        require(recipient != address(0), "ZERO_RECIPIENT");
        require(bytes(metadataUri).length != 0, "EMPTY_URI");
        require(initialSupply >= 2, "SUPPLY_TOO_LOW");
        require(initialSupply <= 10000, "SUPPLY_TOO_HIGH");
        require(initialRoyaltyBps <= 1000, "ROYALTY_TOO_HIGH");

        name = collectionName;
        symbol = collectionSymbol;
        totalSupply = initialSupply;
        _tokenUri = metadataUri;

        royaltyReceiver = initialRoyaltyReceiver == address(0)
            ? recipient
            : initialRoyaltyReceiver;

        royaltyBps = initialRoyaltyBps;

        _balances[TOKEN_ID][recipient] = initialSupply;

        emit TransferSingle(
            msg.sender,
            address(0),
            recipient,
            TOKEN_ID,
            initialSupply
        );
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
        return _balances[id][account];
    }

    function balanceOfBatch(
        address[] calldata accounts,
        uint256[] calldata ids
    ) external view returns (uint256[] memory values) {
        require(accounts.length == ids.length, "LENGTH_MISMATCH");

        values = new uint256[](accounts.length);

        for (uint256 i = 0; i < accounts.length; i++) {
            values[i] = balanceOf(accounts[i], ids[i]);
        }
    }

    function uri(uint256 id) external view returns (string memory) {
        require(id == TOKEN_ID, "INVALID_TOKEN_ID");
        return _tokenUri;
    }

    function setApprovalForAll(address operator, bool approved) external {
        require(operator != msg.sender, "SELF_APPROVAL");

        _operatorApprovals[msg.sender][operator] = approved;

        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function isApprovedForAll(address account, address operator)
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
    ) external {
        require(
            msg.sender == from || _operatorApprovals[from][msg.sender],
            "NOT_AUTHORIZED"
        );

        _safeTransferFrom(from, to, id, amount, data);
    }

    function safeBatchTransferFrom(
        address from,
        address to,
        uint256[] calldata ids,
        uint256[] calldata amounts,
        bytes calldata data
    ) external {
        require(
            msg.sender == from || _operatorApprovals[from][msg.sender],
            "NOT_AUTHORIZED"
        );

        require(ids.length == amounts.length, "LENGTH_MISMATCH");
        require(to != address(0), "ZERO_RECIPIENT");

        for (uint256 i = 0; i < ids.length; i++) {
            _transferBalance(from, to, ids[i], amounts[i]);
        }

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
    ) internal {
        require(to != address(0), "ZERO_RECIPIENT");

        _transferBalance(from, to, id, amount);

        emit TransferSingle(msg.sender, from, to, id, amount);

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
    ) internal {
        require(id == TOKEN_ID, "INVALID_TOKEN_ID");

        uint256 fromBalance = _balances[id][from];
        require(fromBalance >= amount, "INSUFFICIENT_BALANCE");

        unchecked {
            _balances[id][from] = fromBalance - amount;
        }

        _balances[id][to] += amount;
    }

    function royaltyInfo(uint256 tokenId, uint256 salePrice)
        external
        view
        returns (address, uint256)
    {
        require(tokenId == TOKEN_ID, "INVALID_TOKEN_ID");

        return (
            royaltyReceiver,
            (salePrice * royaltyBps) / 10000
        );
    }
}
