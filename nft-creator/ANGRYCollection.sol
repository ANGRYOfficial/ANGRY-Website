// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title ANGRY Collection
/// @notice Scalable ERC-721 collection for up to 1,000 unique NFTs with
///         verified metadata, paid/free public minting, creator proceeds,
///         a transparent ANGRY platform fee, and ERC-2981 royalty information.
/// @dev Metadata URIs are committed by a Merkle root at deployment. Tokens are
///      minted only when claimed/distributed, so deployment gas does not grow
///      with the full collection size. Max-per-wallet is a mint limit only;
///      normal ERC-721 transfers remain unrestricted.
contract ANGRYCollection {
    string public name;
    string public symbol;

    address public immutable owner;
    uint256 public immutable maxSupply;
    uint256 public immutable maxPerWallet;
    bytes32 public immutable metadataRoot;

    string public manifestURI;
    bool public publicMintEnabled;
    uint256 public mintPrice;

    address public immutable platformFeeRecipient;
    uint96 public immutable platformFeeBps;

    address public royaltyReceiver;
    uint96 public royaltyBps;

    uint256 public creatorProceeds;
    uint256 public platformProceeds;
    uint256 private _mintedSupply;

    mapping(uint256 => address) private _owners;
    mapping(address => uint256) private _balances;
    mapping(uint256 => address) private _tokenApprovals;
    mapping(address => mapping(address => bool)) private _operatorApprovals;
    mapping(uint256 => string) private _tokenUris;

    /// @notice Number of NFTs originally minted to each wallet through either
    /// creator distribution or public mint. Transfers do not reduce it.
    mapping(address => uint256) public mintedByWallet;

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);
    event PublicMintStatusChanged(bool enabled);
    event MintPriceUpdated(uint256 mintPrice);
    event ManifestURIUpdated(string manifestURI);
    event PrimaryMintPayment(
        address indexed buyer,
        uint256 quantity,
        uint256 totalPaid,
        uint256 creatorShare,
        uint256 platformFee
    );
    event CreatorProceedsWithdrawn(address indexed recipient, uint256 amount);
    event PlatformFeesWithdrawn(address indexed recipient, uint256 amount);

    modifier onlyOwner() {
        require(msg.sender == owner, "NOT_OWNER");
        _;
    }

    constructor(
        string memory collectionName,
        string memory collectionSymbol,
        address creator,
        uint256 collectionMaxSupply,
        uint256 collectionMaxPerWallet,
        bytes32 collectionMetadataRoot,
        string memory collectionManifestURI,
        uint256 initialMintPrice,
        address initialPlatformFeeRecipient,
        uint96 initialPlatformFeeBps,
        address initialRoyaltyReceiver,
        uint96 initialRoyaltyBps
    ) {
        require(creator != address(0), "ZERO_CREATOR");
        require(collectionMaxSupply >= 2, "MIN_SUPPLY_2");
        require(collectionMaxSupply <= 1000, "MAX_SUPPLY_1000");
        require(
            collectionMaxPerWallet == 0 ||
                collectionMaxPerWallet <= collectionMaxSupply,
            "WALLET_LIMIT_TOO_HIGH"
        );
        require(collectionMetadataRoot != bytes32(0), "EMPTY_METADATA_ROOT");
        require(bytes(collectionManifestURI).length != 0, "EMPTY_MANIFEST_URI");
        require(initialPlatformFeeRecipient != address(0), "ZERO_PLATFORM_RECIPIENT");
        require(initialPlatformFeeBps <= 1000, "PLATFORM_FEE_TOO_HIGH");
        require(initialRoyaltyBps <= 1000, "ROYALTY_TOO_HIGH");

        name = collectionName;
        symbol = collectionSymbol;
        owner = creator;
        maxSupply = collectionMaxSupply;
        maxPerWallet = collectionMaxPerWallet;
        metadataRoot = collectionMetadataRoot;
        manifestURI = collectionManifestURI;
        mintPrice = initialMintPrice;

        platformFeeRecipient = initialPlatformFeeRecipient;
        platformFeeBps = initialPlatformFeeBps;

        royaltyReceiver = initialRoyaltyReceiver == address(0)
            ? creator
            : initialRoyaltyReceiver;
        royaltyBps = initialRoyaltyBps;

        // Creator explicitly opens public mint only when the collection is ready.
        publicMintEnabled = false;
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
        return _mintedSupply;
    }

    function remainingSupply() external view returns (uint256) {
        return maxSupply - _mintedSupply;
    }

    function balanceOf(address owner_) external view returns (uint256) {
        require(owner_ != address(0), "ZERO_ADDRESS");
        return _balances[owner_];
    }

    function ownerOf(uint256 tokenId) public view returns (address) {
        address owner_ = _owners[tokenId];
        require(owner_ != address(0), "NOT_MINTED");
        return owner_;
    }

    function tokenURI(uint256 tokenId) external view returns (string memory) {
        ownerOf(tokenId);
        return _tokenUris[tokenId];
    }

    function setPublicMintEnabled(bool enabled) external onlyOwner {
        publicMintEnabled = enabled;
        emit PublicMintStatusChanged(enabled);
    }

    /// @notice Creator can update the primary mint price without redeploying.
    /// Set to zero for a free public mint.
    function setMintPrice(uint256 newMintPrice) external onlyOwner {
        mintPrice = newMintPrice;
        emit MintPriceUpdated(newMintPrice);
    }

    /// @notice The manifest location may move, but metadataRoot is immutable and
    /// continues to determine which tokenId/metadataURI pairs are valid.
    function setManifestURI(string calldata newManifestURI) external onlyOwner {
        require(bytes(newManifestURI).length != 0, "EMPTY_MANIFEST_URI");
        manifestURI = newManifestURI;
        emit ManifestURIUpdated(newManifestURI);
    }

    /// @notice Collector mints one verified NFT and pays exactly mintPrice.
    function publicMint(
        uint256 tokenId,
        string calldata metadataUri,
        bytes32[] calldata proof
    ) external payable {
        require(publicMintEnabled, "PUBLIC_MINT_DISABLED");
        require(msg.value == mintPrice, "WRONG_MINT_PAYMENT");

        _mintVerified(msg.sender, tokenId, metadataUri, proof);
        _recordPrimarySale(msg.sender, 1, msg.value);
    }

    /// @notice Collector mints a verified batch. Payment must equal
    /// mintPrice * quantity. Gas limits naturally cap practical batch size.
    function publicMintBatch(
        uint256[] calldata tokenIds,
        string[] calldata metadataUris,
        bytes32[][] calldata proofs
    ) external payable {
        require(publicMintEnabled, "PUBLIC_MINT_DISABLED");
        require(tokenIds.length == metadataUris.length, "LENGTH_MISMATCH");
        require(tokenIds.length == proofs.length, "LENGTH_MISMATCH");
        require(tokenIds.length != 0, "EMPTY_BATCH");
        require(msg.value == mintPrice * tokenIds.length, "WRONG_MINT_PAYMENT");

        for (uint256 i = 0; i < tokenIds.length; i++) {
            _mintVerified(msg.sender, tokenIds[i], metadataUris[i], proofs[i]);
        }

        _recordPrimarySale(msg.sender, tokenIds.length, msg.value);
    }

    /// @notice Free creator distribution / airdrop mint. The configured
    /// max-per-wallet rule still applies to the recipient.
    function creatorMint(
        address to,
        uint256 tokenId,
        string calldata metadataUri,
        bytes32[] calldata proof
    ) external onlyOwner {
        _mintVerified(to, tokenId, metadataUri, proof);
    }

    function creatorMintBatch(
        address to,
        uint256[] calldata tokenIds,
        string[] calldata metadataUris,
        bytes32[][] calldata proofs
    ) external onlyOwner {
        require(to != address(0), "ZERO_RECIPIENT");
        require(tokenIds.length == metadataUris.length, "LENGTH_MISMATCH");
        require(tokenIds.length == proofs.length, "LENGTH_MISMATCH");
        require(tokenIds.length != 0, "EMPTY_BATCH");

        for (uint256 i = 0; i < tokenIds.length; i++) {
            _mintVerified(to, tokenIds[i], metadataUris[i], proofs[i]);
        }
    }

    function _recordPrimarySale(
        address buyer,
        uint256 quantity,
        uint256 totalPaid
    ) internal {
        if (totalPaid == 0) {
            emit PrimaryMintPayment(buyer, quantity, 0, 0, 0);
            return;
        }

        uint256 fee = (totalPaid * platformFeeBps) / 10000;
        uint256 creatorShare = totalPaid - fee;

        creatorProceeds += creatorShare;
        platformProceeds += fee;

        emit PrimaryMintPayment(
            buyer,
            quantity,
            totalPaid,
            creatorShare,
            fee
        );
    }

    /// @notice Creator withdraws accumulated primary-sale proceeds.
    function withdrawCreatorProceeds() external onlyOwner {
        uint256 amount = creatorProceeds;
        require(amount != 0, "NO_CREATOR_PROCEEDS");

        creatorProceeds = 0;
        (bool ok, ) = payable(owner).call{value: amount}("");
        require(ok, "CREATOR_WITHDRAW_FAILED");

        emit CreatorProceedsWithdrawn(owner, amount);
    }

    /// @notice ANGRY platform wallet withdraws its accumulated platform fees.
    function withdrawPlatformFees() external {
        require(msg.sender == platformFeeRecipient, "NOT_PLATFORM_RECIPIENT");

        uint256 amount = platformProceeds;
        require(amount != 0, "NO_PLATFORM_FEES");

        platformProceeds = 0;
        (bool ok, ) = payable(platformFeeRecipient).call{value: amount}("");
        require(ok, "PLATFORM_WITHDRAW_FAILED");

        emit PlatformFeesWithdrawn(platformFeeRecipient, amount);
    }

    function _mintVerified(
        address to,
        uint256 tokenId,
        string calldata metadataUri,
        bytes32[] calldata proof
    ) internal {
        require(to != address(0), "ZERO_RECIPIENT");
        require(tokenId >= 1 && tokenId <= maxSupply, "TOKEN_ID_OUT_OF_RANGE");
        require(_owners[tokenId] == address(0), "ALREADY_MINTED");
        require(bytes(metadataUri).length != 0, "EMPTY_URI");
        require(_mintedSupply < maxSupply, "SOLD_OUT");

        if (maxPerWallet != 0) {
            require(
                mintedByWallet[to] + 1 <= maxPerWallet,
                "MAX_PER_WALLET"
            );
        }

        bytes32 leaf = keccak256(
            abi.encodePacked(tokenId, keccak256(bytes(metadataUri)))
        );
        require(_verifyProof(proof, leaf), "INVALID_METADATA_PROOF");

        _owners[tokenId] = to;
        _balances[to] += 1;
        _tokenUris[tokenId] = metadataUri;
        mintedByWallet[to] += 1;
        _mintedSupply += 1;

        emit Transfer(address(0), to, tokenId);
    }

    function _verifyProof(bytes32[] calldata proof, bytes32 leaf)
        internal
        view
        returns (bool)
    {
        bytes32 computedHash = leaf;

        for (uint256 i = 0; i < proof.length; i++) {
            bytes32 proofElement = proof[i];

            if (uint256(computedHash) <= uint256(proofElement)) {
                computedHash = keccak256(
                    abi.encodePacked(computedHash, proofElement)
                );
            } else {
                computedHash = keccak256(
                    abi.encodePacked(proofElement, computedHash)
                );
            }
        }

        return computedHash == metadataRoot;
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

    function getApproved(uint256 tokenId) external view returns (address) {
        ownerOf(tokenId);
        return _tokenApprovals[tokenId];
    }

    function setApprovalForAll(address operator, bool approved) external {
        require(operator != msg.sender, "SELF_OPERATOR");
        _operatorApprovals[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function isApprovedForAll(address owner_, address operator)
        public
        view
        returns (bool)
    {
        return _operatorApprovals[owner_][operator];
    }

    function transferFrom(address from, address to, uint256 tokenId) public {
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

    function safeTransferFrom(address from, address to, uint256 tokenId)
        external
    {
        safeTransferFrom(from, to, tokenId, "");
    }

    function safeTransferFrom(
        address from,
        address to,
        uint256 tokenId,
        bytes memory data
    ) public {
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

    function royaltyInfo(uint256 tokenId, uint256 salePrice)
        external
        view
        returns (address, uint256)
    {
        ownerOf(tokenId);
        return (royaltyReceiver, (salePrice * royaltyBps) / 10000);
    }
}
