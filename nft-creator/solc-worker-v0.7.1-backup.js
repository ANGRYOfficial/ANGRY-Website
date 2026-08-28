import wrapper from "https://esm.sh/solc@0.8.30/wrapper.js?bundle";

const COMPILER_URL="https://binaries.soliditylang.org/bin/soljson-v0.8.30+commit.73712a01.js";

const CONTRACT_SOURCE=`// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title ANGRY 1 of 1 NFT
/// @notice Fixed-supply ERC-721 for the ANGRY NFT Creator Sepolia test path.
///         Token ID #1 is minted in the constructor and there is no later mint function.
contract ANGRYOneOfOne {
    string public name;
    string public symbol;

    address private _tokenOwner;
    address private _approved;
    string private _tokenUri;
    mapping(address => mapping(address => bool)) private _operatorApprovals;

    address public royaltyReceiver;
    uint96 public royaltyBps;

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);

    constructor(
        string memory collectionName,
        string memory collectionSymbol,
        address recipient,
        string memory metadataUri,
        address initialRoyaltyReceiver,
        uint96 initialRoyaltyBps
    ) {
        require(recipient != address(0), "ZERO_RECIPIENT");
        require(bytes(metadataUri).length != 0, "EMPTY_URI");
        require(initialRoyaltyBps <= 1000, "ROYALTY_TOO_HIGH");

        name = collectionName;
        symbol = collectionSymbol;
        _tokenOwner = recipient;
        _tokenUri = metadataUri;
        royaltyReceiver = initialRoyaltyReceiver == address(0) ? recipient : initialRoyaltyReceiver;
        royaltyBps = initialRoyaltyBps;

        emit Transfer(address(0), recipient, 1);
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x01ffc9a7 || // ERC-165
               interfaceId == 0x80ac58cd || // ERC-721
               interfaceId == 0x5b5e139f || // ERC-721 Metadata
               interfaceId == 0x2a55205a;   // ERC-2981
    }

    function balanceOf(address owner_) external view returns (uint256) {
        require(owner_ != address(0), "ZERO_ADDRESS");
        return _tokenOwner == owner_ ? 1 : 0;
    }

    function ownerOf(uint256 tokenId) public view returns (address) {
        require(tokenId == 1 && _tokenOwner != address(0), "NOT_MINTED");
        return _tokenOwner;
    }

    function tokenURI(uint256 tokenId) external view returns (string memory) {
        ownerOf(tokenId);
        return _tokenUri;
    }

    /// @notice Fixed supply helper for explorers and indexers.
    function totalSupply() external pure returns (uint256) {
        return 1;
    }

    function approve(address to, uint256 tokenId) external {
        address owner_ = ownerOf(tokenId);
        require(msg.sender == owner_ || _operatorApprovals[owner_][msg.sender], "NOT_AUTHORIZED");
        _approved = to;
        emit Approval(owner_, to, tokenId);
    }

    function getApproved(uint256 tokenId) external view returns (address) {
        ownerOf(tokenId);
        return _approved;
    }

    function setApprovalForAll(address operator, bool approved) external {
        require(operator != msg.sender, "SELF_OPERATOR");
        _operatorApprovals[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function isApprovedForAll(address owner_, address operator) public view returns (bool) {
        return _operatorApprovals[owner_][operator];
    }

    function transferFrom(address from, address to, uint256 tokenId) public {
        address owner_ = ownerOf(tokenId);
        require(owner_ == from, "WRONG_FROM");
        require(to != address(0), "ZERO_RECIPIENT");
        require(
            msg.sender == owner_ ||
            msg.sender == _approved ||
            _operatorApprovals[owner_][msg.sender],
            "NOT_AUTHORIZED"
        );

        _approved = address(0);
        _tokenOwner = to;
        emit Transfer(from, to, tokenId);
    }

    function safeTransferFrom(address from, address to, uint256 tokenId) external {
        safeTransferFrom(from, to, tokenId, "");
    }

    function safeTransferFrom(address from, address to, uint256 tokenId, bytes memory data) public {
        transferFrom(from, to, tokenId);
        if (to.code.length != 0) {
            (bool ok, bytes memory result) = to.call(
                abi.encodeWithSelector(
                    bytes4(keccak256("onERC721Received(address,address,uint256,bytes)")),
                    msg.sender,
                    from,
                    tokenId,
                    data
                )
            );
            require(
                ok &&
                result.length >= 32 &&
                abi.decode(result, (bytes4)) == bytes4(keccak256("onERC721Received(address,address,uint256,bytes)")),
                "UNSAFE_RECIPIENT"
            );
        }
    }

    function royaltyInfo(uint256 tokenId, uint256 salePrice) external view returns (address, uint256) {
        ownerOf(tokenId);
        return (royaltyReceiver, (salePrice * royaltyBps) / 10000);
    }
}
`;

let compilerPromise=null;

async function getCompiler(){
  if(!compilerPromise){
    compilerPromise=(async()=>{
      const response=await fetch(COMPILER_URL,{cache:"force-cache"});
      if(!response.ok)throw new Error("Could not load Solidity compiler ("+response.status+").");
      const source=await response.text();
      const Module=Function(source+"\n;return Module;")();
      return wrapper(Module);
    })();
  }
  return compilerPromise;
}

self.addEventListener("message",async(event)=>{
  const {id,action}=event.data||{};
  if(action!=="compile")return;
  try{
    const compiler=await getCompiler();
    const input={
      language:"Solidity",
      sources:{"ANGRYOneOfOne.sol":{content:CONTRACT_SOURCE}},
      settings:{
        optimizer:{enabled:true,runs:200},
        evmVersion:"prague",
        outputSelection:{"*":{"*":["abi","evm.bytecode.object"]}}
      }
    };
    const output=JSON.parse(compiler.compile(JSON.stringify(input)));
    const errors=(output.errors||[]);
    const fatal=errors.filter(x=>x.severity==="error");
    if(fatal.length)throw new Error(fatal.map(x=>x.formattedMessage||x.message).join("\n"));
    const c=output.contracts?.["ANGRYOneOfOne.sol"]?.ANGRYOneOfOne;
    if(!c?.evm?.bytecode?.object)throw new Error("Compiler returned no deployment bytecode.");
    self.postMessage({id,ok:true,abi:c.abi,bytecode:"0x"+c.evm.bytecode.object,warnings:errors.filter(x=>x.severity!=="error").map(x=>x.formattedMessage||x.message)});
  }catch(error){
    self.postMessage({id,ok:false,error:error?.message||String(error)});
  }
});