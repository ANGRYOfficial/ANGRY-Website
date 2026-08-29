// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/*
 * ANGRY Liquidity Token - TESTNET CORE
 *
 * Features:
 * - Fixed supply ERC-20
 * - Holder reflection in the token itself
 * - Liquidity fee reserved inside the contract
 * - Project / creator fee sent to project wallet
 *
 * IMPORTANT:
 * Liquidity reserve is NOT automatically deposited to a DEX yet.
 * DEX-router integration is added separately per supported network.
 */
interface IAngryLiquidityPair {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function factory() external view returns (address);
}

contract AngryLiquidityTokenTest {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;

    uint256 private _totalSupply;

    uint256 private constant MAX = type(uint256).max;
    uint256 private _reflectedSupply;

    mapping(address => uint256) private _reflectedBalance;
    mapping(address => mapping(address => uint256)) private _allowances;

    address public immutable projectWallet;

    // Liquidity destination.
    // The planned liquidity fee stays inactive until a valid
    // destination has been configured and explicitly activated.
    address public dexRouter;
    address public dexFactory;
    address public liquidityPair;
    address public wrappedNative;

    bool public liquidityConfigured;
    bool public liquidityActive;
    bool public liquidityDestinationLocked;

    // 100 basis points = 1%
    uint16 public immutable holderFeeBps;
    uint16 public immutable liquidityFeeBps;
    uint16 public immutable projectFeeBps;
    uint16 public immutable burnFeeBps;

    uint256 public totalHolderFees;
    uint256 public totalLiquidityReserved;
    uint256 public totalProjectFees;
    uint256 public totalBurned;

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

    event FeesTaken(
        uint256 holderAmount,
        uint256 liquidityAmount,
        uint256 projectAmount,
        uint256 burnAmount
    );

    event LiquidityDestinationConfigured(
        address indexed router,
        address indexed factory,
        address indexed pair,
        address wrappedNative
    );

    event LiquidityReserveActivated(
        address indexed pair
    );

    event LiquidityReserveDeactivated(
        address indexed pair
    );

    constructor(
        string memory name_,
        string memory symbol_,
        uint256 supply_,
        address projectWallet_,
        uint16 holderFeeBps_,
        uint16 liquidityFeeBps_,
        uint16 projectFeeBps_,
        uint16 burnFeeBps_
    ) {
        require(bytes(name_).length > 0, "Name required");
        require(bytes(symbol_).length > 0, "Symbol required");
        require(supply_ > 0, "Supply required");
        require(projectWallet_ != address(0), "Project wallet required");

        require(holderFeeBps_ <= 500, "Holder fee max 5%");
        require(liquidityFeeBps_ <= 500, "Liquidity fee max 5%");
        require(projectFeeBps_ <= 500, "Project fee max 5%");
        require(burnFeeBps_ <= 500, "Burn fee max 5%");

        // Safer combined limit for the real deployment path.
        require(
            uint256(holderFeeBps_) +
            uint256(liquidityFeeBps_) +
            uint256(projectFeeBps_) +
            uint256(burnFeeBps_) <= 1000,
            "Total fee max 10%"
        );

        name = name_;
        symbol = symbol_;

        projectWallet = projectWallet_;

        holderFeeBps = holderFeeBps_;
        liquidityFeeBps = liquidityFeeBps_;
        projectFeeBps = projectFeeBps_;
        burnFeeBps = burnFeeBps_;

        _totalSupply = supply_ * (10 ** uint256(decimals));

        _reflectedSupply =
            MAX - (MAX % _totalSupply);

        _reflectedBalance[msg.sender] =
            _reflectedSupply;

        emit Transfer(
            address(0),
            msg.sender,
            _totalSupply
        );
    }

    modifier onlyProjectWallet() {
        require(
            msg.sender == projectWallet,
            "Only project wallet"
        );
        _;
    }

    function configureLiquidityDestination(
        address router_,
        address factory_,
        address pair_,
        address wrappedNative_
    )
        external
        onlyProjectWallet
    {
        require(
            liquidityFeeBps > 0,
            "Liquidity fee disabled"
        );

        require(
            !liquidityDestinationLocked,
            "Liquidity destination locked"
        );

        require(router_ != address(0), "Router required");
        require(factory_ != address(0), "Factory required");
        require(pair_ != address(0), "Pair required");
        require(
            wrappedNative_ != address(0),
            "Wrapped native required"
        );

        require(
            router_.code.length > 0,
            "Router must be contract"
        );

        require(
            factory_.code.length > 0,
            "Factory must be contract"
        );

        require(
            pair_.code.length > 0,
            "Pair must be contract"
        );

        require(
            wrappedNative_.code.length > 0,
            "Wrapped native must be contract"
        );

        IAngryLiquidityPair pair =
            IAngryLiquidityPair(pair_);

        require(
            pair.factory() == factory_,
            "Pair factory mismatch"
        );

        address token0_ = pair.token0();
        address token1_ = pair.token1();

        require(
            (
                token0_ == address(this) &&
                token1_ == wrappedNative_
            ) ||
            (
                token1_ == address(this) &&
                token0_ == wrappedNative_
            ),
            "Invalid liquidity pair"
        );

        dexRouter = router_;
        dexFactory = factory_;
        liquidityPair = pair_;
        wrappedNative = wrappedNative_;

        liquidityConfigured = true;
        liquidityActive = false;

        emit LiquidityDestinationConfigured(
            router_,
            factory_,
            pair_,
            wrappedNative_
        );
    }

    function activateLiquidityReserve()
        external
        onlyProjectWallet
    {
        require(
            liquidityFeeBps > 0,
            "Liquidity fee disabled"
        );

        require(
            liquidityConfigured,
            "Liquidity not configured"
        );

        require(
            liquidityPair != address(0),
            "Liquidity pair required"
        );

        liquidityActive = true;

        // Once activated for the first time the destination
        // can no longer be silently changed.
        liquidityDestinationLocked = true;

        emit LiquidityReserveActivated(
            liquidityPair
        );
    }

    function deactivateLiquidityReserve()
        external
        onlyProjectWallet
    {
        liquidityActive = false;

        emit LiquidityReserveDeactivated(
            liquidityPair
        );
    }

    function totalSupply()
        external
        view
        returns (uint256)
    {
        return _totalSupply;
    }

    function balanceOf(address account)
        public
        view
        returns (uint256)
    {
        return tokenFromReflection(
            _reflectedBalance[account]
        );
    }

    function allowance(
        address owner,
        address spender
    )
        external
        view
        returns (uint256)
    {
        return _allowances[owner][spender];
    }

    function approve(
        address spender,
        uint256 amount
    )
        external
        returns (bool)
    {
        require(spender != address(0), "Zero spender");

        _allowances[msg.sender][spender] = amount;

        emit Approval(
            msg.sender,
            spender,
            amount
        );

        return true;
    }

    function transfer(
        address to,
        uint256 amount
    )
        external
        returns (bool)
    {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(
        address from,
        address to,
        uint256 amount
    )
        external
        returns (bool)
    {
        uint256 currentAllowance =
            _allowances[from][msg.sender];

        require(
            currentAllowance >= amount,
            "Allowance exceeded"
        );

        if (currentAllowance != type(uint256).max) {
            _allowances[from][msg.sender] =
                currentAllowance - amount;

            emit Approval(
                from,
                msg.sender,
                _allowances[from][msg.sender]
            );
        }

        _transfer(from, to, amount);
        return true;
    }

    function tokenFromReflection(
        uint256 reflectedAmount
    )
        public
        view
        returns (uint256)
    {
        require(
            reflectedAmount <= _reflectedSupply,
            "Reflection amount too large"
        );

        uint256 rate =
            _reflectedSupply / _totalSupply;

        return reflectedAmount / rate;
    }

    function liquidityReserveBalance()
        external
        view
        returns (uint256)
    {
        return balanceOf(address(this));
    }

    function totalFeeBps()
        external
        view
        returns (uint256)
    {
        return
            uint256(holderFeeBps) +
            (
                liquidityActive
                    ? uint256(liquidityFeeBps)
                    : uint256(0)
            ) +
            uint256(projectFeeBps) +
            uint256(burnFeeBps);
    }

    function plannedTotalFeeBps()
        external
        view
        returns (uint256)
    {
        return
            uint256(holderFeeBps) +
            uint256(liquidityFeeBps) +
            uint256(projectFeeBps) +
            uint256(burnFeeBps);
    }

    function _transfer(
        address from,
        address to,
        uint256 amount
    )
        internal
    {
        require(from != address(0), "Zero sender");
        require(to != address(0), "Zero recipient");
        require(amount > 0, "Amount required");
        require(balanceOf(from) >= amount, "Insufficient balance");

        uint256 holderAmount =
            amount * holderFeeBps / 10000;

        uint256 liquidityAmount = 0;

        // Liquidity fee is never collected before the
        // creator has configured and activated the destination.
        if (
            liquidityActive &&
            liquidityFeeBps > 0
        ) {
            liquidityAmount =
                amount * liquidityFeeBps / 10000;
        }

        uint256 projectAmount =
            amount * projectFeeBps / 10000;

        uint256 burnAmount =
            amount * burnFeeBps / 10000;

        uint256 receivedAmount =
            amount -
            holderAmount -
            liquidityAmount -
            projectAmount -
            burnAmount;

        uint256 rate =
            _reflectedSupply / _totalSupply;

        uint256 reflectedAmount =
            amount * rate;

        uint256 reflectedReceived =
            receivedAmount * rate;

        _reflectedBalance[from] -=
            reflectedAmount;

        _reflectedBalance[to] +=
            reflectedReceived;

        // Reserve liquidity tokens in this contract.
        if (liquidityAmount > 0) {
            _reflectedBalance[address(this)] +=
                liquidityAmount * rate;

            totalLiquidityReserved +=
                liquidityAmount;

            emit Transfer(
                from,
                address(this),
                liquidityAmount
            );
        }

        // Send project allocation directly.
        if (projectAmount > 0) {
            _reflectedBalance[projectWallet] +=
                projectAmount * rate;

            totalProjectFees +=
                projectAmount;

            emit Transfer(
                from,
                projectWallet,
                projectAmount
            );
        }

        // True burn: permanently remove tokens from both
        // token supply and reflected supply.
        if (burnAmount > 0) {
            _reflectedSupply -= burnAmount * rate;
            _totalSupply -= burnAmount;
            totalBurned += burnAmount;

            emit Transfer(
                from,
                address(0),
                burnAmount
            );
        }

        // Reflection: reducing reflected supply increases
        // the token balance represented by existing holders.
        if (holderAmount > 0) {
            _reflectedSupply -=
                holderAmount * rate;

            totalHolderFees +=
                holderAmount;
        }

        emit Transfer(
            from,
            to,
            receivedAmount
        );

        emit FeesTaken(
            holderAmount,
            liquidityAmount,
            projectAmount,
            burnAmount
        );
    }
}
