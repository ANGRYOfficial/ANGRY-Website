// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/*
 * ANGRY Liquidity Token
 *
 * Simple creator flow:
 * - Fixed supply is minted once to the deployer wallet.
 * - Optional holder reflection.
 * - Optional Auto Liquidity.
 * - Optional Project / Creator fee.
 * - Optional true burn.
 *
 * Auto Liquidity:
 * - ANGRY does NOT create or custody the creator's initial LP.
 * - The creator creates the first TOKEN/native pool on the supported DEX.
 * - After that pool has liquidity, the contract can collect the Auto Liquidity
 *   fee and periodically add liquidity automatically.
 * - LP tokens created by Auto Liquidity are sent to projectWallet.
 *
 * Supported by this Ethereum build:
 * - Ethereum Mainnet -> Uniswap V2
 * - Ethereum Sepolia -> Uniswap V2
 *
 * No owner/admin function can change fees or redirect the DEX after deploy.
 */

interface IAngryV2Router {
    function factory() external view returns (address);
    function WETH() external view returns (address);

    function getAmountsOut(
        uint256 amountIn,
        address[] calldata path
    ) external view returns (uint256[] memory amounts);

    function swapExactTokensForETHSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external;

    function addLiquidityETH(
        address token,
        uint256 amountTokenDesired,
        uint256 amountTokenMin,
        uint256 amountETHMin,
        address to,
        uint256 deadline
    )
        external
        payable
        returns (
            uint256 amountToken,
            uint256 amountETH,
            uint256 liquidity
        );
}

interface IAngryV2Factory {
    function getPair(
        address tokenA,
        address tokenB
    ) external view returns (address pair);
}

interface IAngryV2Pair {
    function token0() external view returns (address);

    function getReserves()
        external
        view
        returns (
            uint112 reserve0,
            uint112 reserve1,
            uint32 blockTimestampLast
        );
}

contract AngryLiquidityTokenTest {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;

    uint256 private _totalSupply;

    uint256 private constant MAX = type(uint256).max;
    uint256 private _reflectedSupply;

    mapping(address => uint256) private _reflectedBalance;
    mapping(address => uint256) private _tokenBalance;
    mapping(address => bool) private _excludedFromReflection;
    address[] private _excludedAccounts;

    mapping(address => mapping(address => uint256)) private _allowances;

    address public immutable projectWallet;

    address public immutable dexRouter;
    address public immutable dexFactory;
    address public immutable wrappedNative;

    address public liquidityPair;

    // 100 basis points = 1%
    uint16 public immutable holderFeeBps;
    uint16 public immutable liquidityFeeBps;
    uint16 public immutable projectFeeBps;
    uint16 public immutable burnFeeBps;

    // 0.01% of original supply.
    uint256 public immutable autoLiquidityThreshold;

    // Creator Native uses the same proportional 0.01% threshold.
    uint256 public immutable projectNativeThreshold;

    // Cumulative statistics.
    uint256 public totalHolderFees;
    uint256 public totalLiquidityReserved;
    uint256 public totalProjectFees;
    uint256 public totalBurned;
    uint256 public totalAutoLiquidityTokensUsed;
    uint256 public totalNativeAddedToLiquidity;
    uint256 public totalLpCreated;

    // Only tokens actually collected by each fee are counted here.
    uint256 public pendingLiquidityTokens;
    uint256 public pendingProjectTokens;

    uint256 public totalProjectTokensSwapped;
    uint256 public totalProjectNativePaid;

    // Native project fees that could not be delivered automatically.
    // They remain claimable only by the immutable projectWallet.
    uint256 public pendingProjectNative;

    // Bound automatic callback gas so a hostile/reverting project wallet
    // cannot consume an unbounded amount of a holder transfer's gas.
    uint256 private constant PROJECT_AUTO_PAYOUT_GAS = 100000;

    bool private _inAutoLiquidity;
    bool private _projectProcessTurn;

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

    event LiquidityPairDetected(address indexed pair);

    event AutoLiquidityAdded(
        uint256 tokensSwapped,
        uint256 tokensAdded,
        uint256 nativeAdded,
        uint256 lpCreated
    );

    event AutoLiquidityProcessFailed(
        uint256 attemptedTokenAmount
    );

    event ProjectNativePaid(
        uint256 tokensSwapped,
        uint256 nativePaid
    );

    event ProjectNativeProcessFailed(
        uint256 attemptedTokenAmount
    );

    event ProjectNativeDeferred(
        uint256 tokensSwapped,
        uint256 nativeAmount
    );

    event ProjectNativeClaimed(
        uint256 nativePaid
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
        require(liquidityFeeBps_ <= 500, "Auto liquidity max 5%");
        require(projectFeeBps_ <= 500, "Project fee max 5%");
        require(burnFeeBps_ <= 500, "Burn fee max 5%");

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

        _totalSupply =
            supply_ * (10 ** uint256(decimals));

        _reflectedSupply =
            MAX - (MAX % _totalSupply);

        _reflectedBalance[msg.sender] =
            _reflectedSupply;

        // The token contract must not receive holder reflection,
        // because this balance is reserved for Auto Liquidity.
        _excludeFromReflection(address(this));

        uint256 threshold =
            _totalSupply / 10000;

        autoLiquidityThreshold =
            threshold > 0 ? threshold : 1;

        projectNativeThreshold =
            threshold > 0 ? threshold : 1;

        address router_ = _routerForChain();

        if (
            liquidityFeeBps_ > 0 ||
            projectFeeBps_ > 0
        ) {
            require(
                router_ != address(0),
                "DEX processing unsupported network"
            );

            require(
                router_.code.length > 0,
                "DEX router unavailable"
            );
        }

        address factory_;
        address wrapped_;

        if (router_ != address(0)) {
            factory_ =
                IAngryV2Router(router_).factory();

            wrapped_ =
                IAngryV2Router(router_).WETH();

            require(
                factory_ != address(0) &&
                factory_.code.length > 0,
                "DEX factory unavailable"
            );

            require(
                wrapped_ != address(0) &&
                wrapped_.code.length > 0,
                "Wrapped native unavailable"
            );
        }

        dexRouter = router_;
        dexFactory = factory_;
        wrappedNative = wrapped_;

        if (
            (liquidityFeeBps_ > 0 || projectFeeBps_ > 0) &&
            router_ != address(0)
        ) {
            _allowances[address(this)][router_] =
                type(uint256).max;

            emit Approval(
                address(this),
                router_,
                type(uint256).max
            );
        }

        emit Transfer(
            address(0),
            msg.sender,
            _totalSupply
        );
    }

    receive() external payable {
        require(
            msg.sender == dexRouter,
            "Router only"
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
        if (_excludedFromReflection[account]) {
            return _tokenBalance[account];
        }

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
        require(
            spender != address(0),
            "Zero spender"
        );

        _allowances[msg.sender][spender] =
            amount;

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
        _transfer(
            msg.sender,
            to,
            amount
        );

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

        if (
            currentAllowance !=
            type(uint256).max
        ) {
            _allowances[from][msg.sender] =
                currentAllowance - amount;

            emit Approval(
                from,
                msg.sender,
                _allowances[from][msg.sender]
            );
        }

        _transfer(
            from,
            to,
            amount
        );

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

        uint256 rate = _getRate();

        return
            reflectedAmount / rate;
    }

    function liquidityReserveBalance()
        external
        view
        returns (uint256)
    {
        return pendingLiquidityTokens;
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

    function totalFeeBps()
        external
        view
        returns (uint256)
    {
        uint256 liquidityPart =
            autoLiquidityReady()
                ? uint256(liquidityFeeBps)
                : 0;

        return
            uint256(holderFeeBps) +
            liquidityPart +
            uint256(projectFeeBps) +
            uint256(burnFeeBps);
    }

    function currentLiquidityPair()
        public
        view
        returns (address)
    {
        if (
            liquidityPair != address(0)
        ) {
            return liquidityPair;
        }

        if (
            dexFactory == address(0) ||
            wrappedNative == address(0)
        ) {
            return address(0);
        }

        return
            IAngryV2Factory(dexFactory)
                .getPair(
                    address(this),
                    wrappedNative
                );
    }

    function autoLiquidityReady()
        public
        view
        returns (bool)
    {
        if (
            liquidityFeeBps == 0 ||
            dexRouter == address(0)
        ) {
            return false;
        }

        return
            _pairHasLiquidity(
                currentLiquidityPair()
            );
    }

    // Public sync only caches the official pair returned by the
    // fixed DEX factory. It cannot redirect funds or change settings.
    function syncLiquidityPair()
        external
        returns (address pair)
    {
        pair = _syncLiquidityPair();
    }

    // External self-call lets a failed DEX operation be caught
    // without freezing a normal user transfer.
    function processAutoLiquidity(
        uint256 tokenAmount
    )
        external
    {
        require(
            msg.sender == address(this),
            "Self only"
        );

        require(
            !_inAutoLiquidity,
            "Auto liquidity active"
        );

        require(
            tokenAmount >= 2,
            "Amount too small"
        );

        require(
            pendingLiquidityTokens >= tokenAmount,
            "Pending reserve too low"
        );

        address pair =
            _syncLiquidityPair();

        require(
            _pairHasLiquidity(pair),
            "Pool not ready"
        );

        require(
            balanceOf(address(this)) >= tokenAmount,
            "Contract balance too low"
        );

        uint256 half =
            tokenAmount / 2;

        uint256 otherHalf =
            tokenAmount - half;

        address[] memory path =
            new address[](2);

        path[0] = address(this);
        path[1] = wrappedNative;

        uint256[] memory quoted =
            IAngryV2Router(dexRouter)
                .getAmountsOut(
                    half,
                    path
                );

        require(
            quoted.length >= 2 &&
            quoted[1] > 0,
            "DEX quote failed"
        );

        // Maximum 5% swap slippage.
        uint256 minNativeOut =
            quoted[1] * 95 / 100;

        uint256 nativeBefore =
            address(this).balance;

        _inAutoLiquidity = true;

        IAngryV2Router(dexRouter)
            .swapExactTokensForETHSupportingFeeOnTransferTokens(
                half,
                minNativeOut,
                path,
                address(this),
                block.timestamp + 300
            );

        uint256 nativeReceived =
            address(this).balance -
            nativeBefore;

        require(
            nativeReceived > 0,
            "No native received"
        );

        (
            uint256 tokenUsed,
            uint256 nativeUsed,
            uint256 liquidity
        ) =
            IAngryV2Router(dexRouter)
                .addLiquidityETH{
                    value: nativeReceived
                }(
                    address(this),
                    otherHalf,
                    otherHalf * 90 / 100,
                    nativeReceived * 90 / 100,
                    projectWallet,
                    block.timestamp + 300
                );

        _inAutoLiquidity = false;

        uint256 tokensUsed =
            half + tokenUsed;

        pendingLiquidityTokens -=
            tokensUsed;

        totalAutoLiquidityTokensUsed +=
            tokensUsed;

        totalNativeAddedToLiquidity +=
            nativeUsed;

        totalLpCreated +=
            liquidity;

        emit AutoLiquidityAdded(
            half,
            tokenUsed,
            nativeUsed,
            liquidity
        );
    }


    // Convert accumulated Project / Creator fee tokens into
    // the native coin of the current network.
    //
    // The external self-call allows a failed DEX swap or failed
    // native payment to be caught without freezing a user transfer.
    function processProjectNative(
        uint256 tokenAmount
    )
        external
    {
        require(
            msg.sender == address(this),
            "Self only"
        );

        require(
            !_inAutoLiquidity,
            "DEX process active"
        );

        require(
            tokenAmount > 0,
            "Amount too small"
        );

        require(
            pendingProjectTokens >= tokenAmount,
            "Pending project reserve too low"
        );

        address pair =
            _syncLiquidityPair();

        require(
            _pairHasLiquidity(pair),
            "Pool not ready"
        );

        require(
            balanceOf(address(this)) >= tokenAmount,
            "Contract balance too low"
        );

        address[] memory path =
            new address[](2);

        path[0] = address(this);
        path[1] = wrappedNative;

        uint256[] memory quoted =
            IAngryV2Router(dexRouter)
                .getAmountsOut(
                    tokenAmount,
                    path
                );

        require(
            quoted.length >= 2 &&
            quoted[1] > 0,
            "DEX quote failed"
        );

        // Maximum 5% swap slippage.
        uint256 minNativeOut =
            quoted[1] * 95 / 100;

        uint256 nativeBefore =
            address(this).balance;

        _inAutoLiquidity = true;

        IAngryV2Router(dexRouter)
            .swapExactTokensForETHSupportingFeeOnTransferTokens(
                tokenAmount,
                minNativeOut,
                path,
                address(this),
                block.timestamp + 300
            );

        uint256 nativeReceived =
            address(this).balance -
            nativeBefore;

        require(
            nativeReceived > 0,
            "No native received"
        );

        // Finalize token accounting before calling projectWallet.
        // If the wallet callback reenters this token, the DEX-process
        // guard remains active and another fee-processing cycle cannot start.
        pendingProjectTokens -=
            tokenAmount;

        totalProjectTokensSwapped +=
            tokenAmount;

        // Automatic payout uses bounded gas. A wallet that rejects native
        // coin cannot force the DEX swap to revert on every holder transfer.
        // Failed payouts are safely deferred for an explicit later claim.
        (bool sent, ) =
            payable(projectWallet).call{
                value: nativeReceived,
                gas: PROJECT_AUTO_PAYOUT_GAS
            }("");

        if (sent) {
            totalProjectNativePaid +=
                nativeReceived;

            emit ProjectNativePaid(
                tokenAmount,
                nativeReceived
            );
        }
        else {
            pendingProjectNative +=
                nativeReceived;

            emit ProjectNativeDeferred(
                tokenAmount,
                nativeReceived
            );
        }

        _inAutoLiquidity = false;
    }

    // Pull-payment fallback for smart-contract wallets that cannot accept
    // the bounded-gas automatic payment. Funds can only go to the immutable
    // projectWallet and can never be redirected by an admin or third party.
    function claimProjectNative()
        external
    {
        require(
            msg.sender == projectWallet,
            "Project wallet only"
        );

        require(
            !_inAutoLiquidity,
            "DEX process active"
        );

        uint256 amount =
            pendingProjectNative;

        require(
            amount > 0,
            "No native pending"
        );

        // Checks-effects-interactions + process guard. If the payment fails,
        // the whole claim reverts and the pending amount is restored.
        pendingProjectNative = 0;
        _inAutoLiquidity = true;

        (bool sent, ) =
            payable(projectWallet).call{
                value: amount
            }("");

        require(
            sent,
            "Project native claim failed"
        );

        _inAutoLiquidity = false;

        totalProjectNativePaid +=
            amount;

        emit ProjectNativeClaimed(
            amount
        );
    }

    function _transfer(
        address from,
        address to,
        uint256 amount
    )
        internal
    {
        require(
            from != address(0),
            "Zero sender"
        );

        require(
            to != address(0),
            "Zero recipient"
        );

        require(
            amount > 0,
            "Amount required"
        );

        require(
            balanceOf(from) >= amount,
            "Insufficient balance"
        );

        // During a DEX process, only tokens pulled from this contract
        // by the fixed router bypass fees. A callback from projectWallet
        // must never gain a fee-free transfer path.
        if (
            _inAutoLiquidity &&
            from == address(this)
        ) {
            _rawTransfer(
                from,
                to,
                amount
            );

            return;
        }

        address pair =
            _syncLiquidityPair();

        bool pairReady =
            _pairHasLiquidity(pair);

        // Let the creator make the first LP normally.
        // When the official pair exists but is still empty,
        // the transfer into that pair is fee-free.
        if (
            pair != address(0) &&
            to == pair &&
            !pairReady
        ) {
            _rawTransfer(
                from,
                to,
                amount
            );

            return;
        }

        _maybeProcessFees(
            from,
            pair,
            pairReady
        );

        uint256 holderAmount =
            amount *
            holderFeeBps /
            10000;

        // Auto Liquidity fee only starts after the supported
        // DEX pair has real liquidity.
        uint256 liquidityAmount =
            pairReady
                ? amount *
                    liquidityFeeBps /
                    10000
                : 0;

        uint256 projectAmount =
            amount *
            projectFeeBps /
            10000;

        uint256 burnAmount =
            amount *
            burnFeeBps /
            10000;

        uint256 receivedAmount =
            amount -
            holderAmount -
            liquidityAmount -
            projectAmount -
            burnAmount;

        uint256 rate =
            _getRate();

        uint256 reflectedAmount =
            amount * rate;

        _debit(
            from,
            amount,
            reflectedAmount
        );

        _credit(
            to,
            receivedAmount,
            receivedAmount * rate
        );

        if (
            liquidityAmount > 0
        ) {
            _credit(
                address(this),
                liquidityAmount,
                liquidityAmount * rate
            );

            pendingLiquidityTokens +=
                liquidityAmount;

            totalLiquidityReserved +=
                liquidityAmount;

            emit Transfer(
                from,
                address(this),
                liquidityAmount
            );
        }

        if (
            projectAmount > 0
        ) {
            _credit(
                address(this),
                projectAmount,
                projectAmount * rate
            );

            pendingProjectTokens +=
                projectAmount;

            totalProjectFees +=
                projectAmount;

            emit Transfer(
                from,
                address(this),
                projectAmount
            );
        }

        if (
            burnAmount > 0
        ) {
            uint256 reflectedBurn =
                burnAmount * rate;

            _reflectedSupply -=
                reflectedBurn;

            _totalSupply -=
                burnAmount;

            totalBurned +=
                burnAmount;

            emit Transfer(
                from,
                address(0),
                burnAmount
            );
        }

        if (
            holderAmount > 0
        ) {
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


    function _maybeProcessFees(
        address from,
        address pair,
        bool pairReady
    )
        internal
    {
        if (
            _inAutoLiquidity ||
            !pairReady ||
            from == pair ||
            from == address(this)
        ) {
            return;
        }

        bool liquidityReady =
            liquidityFeeBps > 0 &&
            pendingLiquidityTokens >=
                autoLiquidityThreshold;

        bool projectReady =
            projectFeeBps > 0 &&
            pendingProjectTokens >=
                projectNativeThreshold;

        if (
            !liquidityReady &&
            !projectReady
        ) {
            return;
        }

        bool processProject =
            projectReady &&
            (
                !liquidityReady ||
                _projectProcessTurn
            );

        if (processProject) {
            uint256 amount =
                _safeProcessAmount(
                    pair,
                    pendingProjectTokens
                );

            if (amount > 0) {
                try
                    this.processProjectNative(
                        amount
                    )
                {
                    // Success event emitted inside processor.
                }
                catch {
                    emit ProjectNativeProcessFailed(
                        amount
                    );
                }
            }
        }
        else {
            uint256 amount =
                _safeProcessAmount(
                    pair,
                    pendingLiquidityTokens
                );

            if (amount >= 2) {
                try
                    this.processAutoLiquidity(
                        amount
                    )
                {
                    // Success event emitted inside processor.
                }
                catch {
                    emit AutoLiquidityProcessFailed(
                        amount
                    );
                }
            }
        }

        if (
            liquidityReady &&
            projectReady
        ) {
            _projectProcessTurn =
                !_projectProcessTurn;
        }
    }

    function _rawTransfer(
        address from,
        address to,
        uint256 amount
    )
        internal
    {
        uint256 rate =
            _getRate();

        uint256 reflectedAmount =
            amount * rate;

        _debit(
            from,
            amount,
            reflectedAmount
        );

        _credit(
            to,
            amount,
            reflectedAmount
        );

        emit Transfer(
            from,
            to,
            amount
        );
    }

    function _debit(
        address account,
        uint256 tokenAmount,
        uint256 reflectedAmount
    )
        internal
    {
        _reflectedBalance[account] -=
            reflectedAmount;

        if (
            _excludedFromReflection[account]
        ) {
            _tokenBalance[account] -=
                tokenAmount;
        }
    }

    function _credit(
        address account,
        uint256 tokenAmount,
        uint256 reflectedAmount
    )
        internal
    {
        _reflectedBalance[account] +=
            reflectedAmount;

        if (
            _excludedFromReflection[account]
        ) {
            _tokenBalance[account] +=
                tokenAmount;
        }
    }

    function _syncLiquidityPair()
        internal
        returns (address pair)
    {
        pair = liquidityPair;

        if (
            pair != address(0)
        ) {
            return pair;
        }

        if (
            dexFactory == address(0) ||
            wrappedNative == address(0)
        ) {
            return address(0);
        }

        pair =
            IAngryV2Factory(dexFactory)
                .getPair(
                    address(this),
                    wrappedNative
                );

        if (
            pair != address(0)
        ) {
            require(
                pair.code.length > 0,
                "Invalid DEX pair"
            );

            liquidityPair = pair;

            // AMM pair must not receive holder reflection,
            // otherwise its token balance can drift away
            // from its stored reserves.
            _excludeFromReflection(pair);

            emit LiquidityPairDetected(
                pair
            );
        }
    }

    function _pairHasLiquidity(
        address pair
    )
        internal
        view
        returns (bool)
    {
        if (
            pair == address(0) ||
            pair.code.length == 0
        ) {
            return false;
        }

        try
            IAngryV2Pair(pair)
                .getReserves()
        returns (
            uint112 reserve0,
            uint112 reserve1,
            uint32
        ) {
            return
                reserve0 > 0 &&
                reserve1 > 0;
        }
        catch {
            return false;
        }
    }

    function _safeProcessAmount(
        address pair,
        uint256 pendingAmount
    )
        internal
        view
        returns (uint256)
    {
        uint256 amount =
            autoLiquidityThreshold;

        if (
            amount > pendingAmount
        ) {
            amount = pendingAmount;
        }

        try
            IAngryV2Pair(pair)
                .getReserves()
        returns (
            uint112 reserve0,
            uint112 reserve1,
            uint32
        ) {
            address token0 =
                IAngryV2Pair(pair)
                    .token0();

            uint256 tokenReserve =
                token0 == address(this)
                    ? uint256(reserve0)
                    : uint256(reserve1);

            // Never process more than 0.5% of the pool's
            // current token reserve in one automatic cycle.
            uint256 reserveCap =
                tokenReserve / 200;

            if (
                reserveCap < amount
            ) {
                amount =
                    reserveCap;
            }
        }
        catch {
            return 0;
        }

        return amount;
    }

    function _excludeFromReflection(
        address account
    )
        internal
    {
        if (
            _excludedFromReflection[account]
        ) {
            return;
        }

        if (
            _reflectedBalance[account] > 0
        ) {
            _tokenBalance[account] =
                tokenFromReflection(
                    _reflectedBalance[account]
                );
        }

        _excludedFromReflection[account] =
            true;

        _excludedAccounts.push(
            account
        );
    }

    function _getRate()
        internal
        view
        returns (uint256)
    {
        (
            uint256 reflectedSupply,
            uint256 tokenSupply
        ) =
            _getCurrentSupply();

        return
            reflectedSupply /
            tokenSupply;
    }

    function _getCurrentSupply()
        internal
        view
        returns (
            uint256 reflectedSupply,
            uint256 tokenSupply
        )
    {
        reflectedSupply =
            _reflectedSupply;

        tokenSupply =
            _totalSupply;

        uint256 length =
            _excludedAccounts.length;

        for (
            uint256 i = 0;
            i < length;
            i++
        ) {
            address account =
                _excludedAccounts[i];

            uint256 reflectedOwned =
                _reflectedBalance[account];

            uint256 tokenOwned =
                _tokenBalance[account];

            if (
                reflectedOwned >
                    reflectedSupply ||
                tokenOwned >
                    tokenSupply
            ) {
                return (
                    _reflectedSupply,
                    _totalSupply
                );
            }

            reflectedSupply -=
                reflectedOwned;

            tokenSupply -=
                tokenOwned;
        }

        if (
            tokenSupply == 0 ||
            reflectedSupply <
                _reflectedSupply /
                _totalSupply
        ) {
            return (
                _reflectedSupply,
                _totalSupply
            );
        }
    }

    function _routerForChain()
        internal
        view
        returns (address)
    {
        // Arbitrum One Mainnet - Uniswap V2 Router02
        if (
            block.chainid == 42161
        ) {
            return
                0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24;
        }

        return address(0);
    }
}
