// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/*
  ANGRY Standard Token + Atomic Fee Factory
  TESTNET ONLY

  This contract is for testing the atomic creation/payment flow.
  Do not use on mainnet before review/audit.
*/

contract AngryStandardTokenTest {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;

    uint256 public totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(
        address indexed from,
        address indexed to,
        uint256 value
    );

    event Approval(
        address indexed owner,
        address indexed spender,
        uint256 value
    );

    constructor(
        string memory name_,
        string memory symbol_,
        uint256 humanSupply_,
        address recipient_
    ) {
        require(bytes(name_).length > 0, "Name required");
        require(bytes(symbol_).length > 0, "Symbol required");
        require(humanSupply_ > 0, "Supply required");
        require(recipient_ != address(0), "Invalid recipient");

        name = name_;
        symbol = symbol_;

        totalSupply = humanSupply_ * (10 ** uint256(decimals));
        balanceOf[recipient_] = totalSupply;

        emit Transfer(address(0), recipient_, totalSupply);
    }

    function transfer(
        address to,
        uint256 value
    ) external returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function approve(
        address spender,
        uint256 value
    ) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transferFrom(
        address from,
        address to,
        uint256 value
    ) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];

        require(allowed >= value, "Allowance too low");

        allowance[from][msg.sender] = allowed - value;
        _transfer(from, to, value);

        return true;
    }

    function _transfer(
        address from,
        address to,
        uint256 value
    ) internal {
        require(to != address(0), "Invalid recipient");
        require(balanceOf[from] >= value, "Balance too low");

        balanceOf[from] -= value;
        balanceOf[to] += value;

        emit Transfer(from, to, value);
    }
}


contract AngryStandardFactoryTest {

    address payable public constant TREASURY =
        payable(0x1479d63c37445bb4dce7a3833809fdab3a7e272a);

    // TESTNET ONLY: 0.000001 ETH
    uint256 public constant TEST_FEE = 0.000001 ether;

    event TokenCreated(
        address indexed creator,
        address indexed token,
        uint256 fee
    );

    function createStandardToken(
        string calldata name_,
        string calldata symbol_,
        uint256 supply_
    ) external payable returns (address token) {

        require(msg.value == TEST_FEE, "Incorrect ANGRY fee");

        /*
          If token creation below fails,
          the whole transaction reverts.
        */
        AngryStandardTokenTest deployed =
            new AngryStandardTokenTest(
                name_,
                symbol_,
                supply_,
                msg.sender
            );

        token = address(deployed);

        /*
          Fee is sent only after token creation succeeds.
          If this transfer fails, token creation also reverts.
        */
        (bool paid, ) = TREASURY.call{value: msg.value}("");

        require(paid, "Treasury payment failed");

        emit TokenCreated(
            msg.sender,
            token,
            msg.value
        );
    }
}
