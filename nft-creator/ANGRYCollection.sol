// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title ANGRY Collection
/// @notice Fixed-supply ERC-721 collection.
/// Each Token ID has its own metadata URI.
/// All NFTs are minted in the constructor.
/// There is no later mint function.

contract ANGRYCollection {
    string public name;
    string public symbol;

    uint256 public immutable maxSupply;

    address public royaltyReceiver;
    uint96 public royaltyBps;

    mapping(uint256 => address) private _owners;
    mapping(address => uint256) private _balances;
    mapping(uint256 => address) private _tokenApprovals;
    mapping(address => mapping(address => bool)) private _operatorApprovals;
    mapping(uint256 => string) private _tokenUris;

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);

    constructor(
        string memory collectionName,
        string memory collectionSymbol,
        address recipient,
        string[] memory metadataUris,
        address initialRoyaltyReceiver,
        uint96 initialRoyaltyBps
    ) {
        require(recipient != address(0), "ZERO_RECIPIENT");
        require(metadataUris.length >= 2, "MIN_SUPPLY_2");
        require(metadataUris.length <= 100, "MAX_SUPPLY_100");
        require(initialRoyaltyBps <= 1000, "ROYALTY_TOO_HIGH");

        name = collectionName;
        symbol = collectionSymbol;
        maxSupply = metadataUris.length;

        royaltyReceiver =
            initialRoyaltyReceiver == address(0)
                ? recipient
                : initialRoyaltyReceiver;

        royaltyBps = initialRoyaltyBps;

        for (uint256 i = 0; i < metadataUris.length; i++) {
            require(bytes(metadataUris[i]).length != 0, "EMPTY_URI");

            uint256 tokenId = i + 1;

            _owners[tokenId] = recipient;
            _balances[recipient] += 1;
            _tokenUris[tokenId] = metadataUris[i];

            emit Transfer(address(0), recipient, tokenId);
        }
    }

    function supportsInterface(bytes4 interfaceId)
        external
        pure
        returns (bool)
    {
        return
            interfaceId == 0x01ffc9a7 || // ERC-165
            interfaceId == 0x80ac58cd || // ERC-721
            interfaceId == 0x5b5e139f || // ERC-721 Metadata
            interfaceId == 0x2a55205a;   // ERC-2981
    }

    function totalSupply() external view returns (uint256) {
        return maxSupply;
    }

    function balanceOf(address owner_)
        external
        view
        returns (uint256)
    {
        require(owner_ != address(0), "ZERO_ADDRESS");
        return _balances[owner_];
    }

    function ownerOf(uint256 tokenId)
        public
        view
        returns (address)
    {
        address owner_ = _owners[tokenId];
        require(owner_ != address(0), "NOT_MINTED");
        return owner_;
    }

    function tokenURI(uint256 tokenId)
        external
        view
        returns (string memory)
    {
        ownerOf(tokenId);
        return _tokenUris[tokenId];
    }

    function approve(address to, uint256 tokenId) external {
        address owner_ = ownerOf(tokenId);

        require(
            msg.sender == owner_ ||
            _operatorApprovals[owner_][msg.sender],
            "NOT_AUTHORIZED"
        );

        _tokenApprovals[tokenId] = to;
        emit Approval(owner_, to, tokenId);
    }

    function getApproved(uint256 tokenId)
        external
        view
        returns (address)
    {
        ownerOf(tokenId);
        return _tokenApprovals[tokenId];
    }

    function setApprovalForAll(address operator, bool approved)
        external
    {
        require(operator != msg.sender, "SELF_OPERATOR");

        _operatorApprovals[msg.sender][operator] = approved;

        emit ApprovalForAll(
            msg.sender,
            operator,
            approved
        );
    }

    function isApprovedForAll(
        address owner_,
        address operator
    )
        public
        view
        returns (bool)
    {
        return _operatorApprovals[owner_][operator];
    }

    function transferFrom(
        address from,
        address to,
        uint256 tokenId
    )
        public
    {
        address owner_ = ownerOf(tokenId);

        require(owner_ == from, "WRONG_FROM");
        require(to != address(0), "ZERO_RECIPIENT");

        require(
            msg.sender == owner_ ||
            msg.sender == _tokenApprovals[tokenId] ||
            _operatorApprovals[owner_][msg.sender],
            "NOT_AUTHORIZED"
        );

        delete _tokenApprovals[tokenId];

        _balances[from] -= 1;
        _balances[to] += 1;
        _owners[tokenId] = to;

        emit Transfer(from, to, tokenId);
    }

    function safeTransferFrom(
        address from,
        address to,
        uint256 tokenId
    )
        external
    {
        safeTransferFrom(from, to, tokenId, "");
    }

    function safeTransferFrom(
        address from,
        address to,
        uint256 tokenId,
        bytes memory data
    )
        public
    {
        transferFrom(from, to, tokenId);

        if (to.code.length != 0) {
            (bool ok, bytes memory result) = to.call(
                abi.encodeWithSelector(
                    bytes4(
                        keccak256(
                            "onERC721Received(address,address,uint256,bytes)"
                        )
                    ),
                    msg.sender,
                    from,
                    tokenId,
                    data
                )
            );

            require(
                ok &&
                result.length >= 32 &&
                abi.decode(result, (bytes4)) ==
                    bytes4(
                        keccak256(
                            "onERC721Received(address,address,uint256,bytes)"
                        )
                    ),
                "UNSAFE_RECIPIENT"
            );
        }
    }

    function royaltyInfo(
        uint256 tokenId,
        uint256 salePrice
    )
        external
        view
        returns (address, uint256)
    {
        ownerOf(tokenId);

        return (
            royaltyReceiver,
            (salePrice * royaltyBps) / 10000
        );
    }
}
