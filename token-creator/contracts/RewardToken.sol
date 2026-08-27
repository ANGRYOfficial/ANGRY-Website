// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/*
 * ANGRY Reward Token - TESTNET CORE
 *
 * Real testnet functionality:
 * - Fixed-supply ERC-20
 * - Reward reserve fee
 * - Liquidity reserve fee
 * - Project / creator fee
 * - External ERC-20 reward asset
 * - Proportional reward accounting
 * - Holders can claim reward tokens
 *
 * TESTNET LIMITATION:
 * Reward/Liquidity reserves are NOT automatically swapped on a DEX yet.
 * fundRewards() simulates/funds the external reward asset distribution.
 */

interface IERC20Reward {
    function balanceOf(address account)
        external
        view
        returns (uint256);

    function transfer(address to, uint256 amount)
        external
        returns (bool);

    function transferFrom(
        address from,
        address to,
        uint256 amount
    )
        external
        returns (bool);
}

contract AngryRewardTokenTest {

    string public name;
    string public symbol;
    uint8 public constant decimals = 18;

    uint256 private _totalSupply;

    mapping(address => uint256) private _balances;
    mapping(address => mapping(address => uint256))
        private _allowances;

    address public immutable projectWallet;
    address public immutable rewardToken;

    // 100 basis points = 1%
    uint16 public immutable rewardFeeBps;
    uint16 public immutable liquidityFeeBps;
    uint16 public immutable projectFeeBps;

    uint256 public totalRewardTokenReserved;
    uint256 public totalLiquidityTokenReserved;
    uint256 public totalProjectFees;

    /*
     * Dividend accounting.
     *
     * The contract's own token reserve is excluded from reward eligibility.
     */
    uint256 private constant MAGNITUDE = 2 ** 128;

    uint256 public magnifiedRewardPerShare;
    uint256 public totalExternalRewardsFunded;
    uint256 public totalExternalRewardsClaimed;

    mapping(address => int256)
        private magnifiedRewardCorrections;

    mapping(address => uint256)
        public withdrawnRewards;

    bool private _claimLock;

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
        uint256 rewardReserve,
        uint256 liquidityReserve,
        uint256 projectAmount
    );

    event RewardsFunded(
        address indexed funder,
        uint256 amount
    );

    event RewardClaimed(
        address indexed holder,
        uint256 amount
    );

    constructor(
        string memory name_,
        string memory symbol_,
        uint256 supply_,
        address projectWallet_,
        address rewardToken_,
        uint16 rewardFeeBps_,
        uint16 liquidityFeeBps_,
        uint16 projectFeeBps_
    ) {
        require(
            bytes(name_).length > 0,
            "Name required"
        );

        require(
            bytes(symbol_).length > 0,
            "Symbol required"
        );

        require(
            supply_ > 0,
            "Supply required"
        );

        require(
            projectWallet_ != address(0),
            "Project wallet required"
        );

        require(
            rewardToken_ != address(0),
            "Reward token required"
        );

        require(
            rewardToken_.code.length > 0,
            "Reward token must be contract"
        );

        require(
            rewardFeeBps_ <= 500,
            "Reward fee max 5%"
        );

        require(
            liquidityFeeBps_ <= 500,
            "Liquidity fee max 5%"
        );

        require(
            projectFeeBps_ <= 500,
            "Project fee max 5%"
        );

        require(
            uint256(rewardFeeBps_) +
            uint256(liquidityFeeBps_) +
            uint256(projectFeeBps_) <= 1000,
            "Total fee max 10%"
        );

        name = name_;
        symbol = symbol_;

        projectWallet = projectWallet_;
        rewardToken = rewardToken_;

        rewardFeeBps = rewardFeeBps_;
        liquidityFeeBps = liquidityFeeBps_;
        projectFeeBps = projectFeeBps_;

        _totalSupply =
            supply_ * (10 ** uint256(decimals));

        _balances[msg.sender] =
            _totalSupply;

        emit Transfer(
            address(0),
            msg.sender,
            _totalSupply
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
        return _balances[account];
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

    function totalFeeBps()
        external
        view
        returns (uint256)
    {
        return
            uint256(rewardFeeBps) +
            uint256(liquidityFeeBps) +
            uint256(projectFeeBps);
    }

    function rewardEligibleSupply()
        public
        view
        returns (uint256)
    {
        return
            _totalSupply -
            _balances[address(this)];
    }

    function rewardReserveBalance()
        external
        view
        returns (uint256)
    {
        return totalRewardTokenReserved;
    }

    function liquidityReserveBalance()
        external
        view
        returns (uint256)
    {
        return totalLiquidityTokenReserved;
    }

    function contractTokenBalance()
        external
        view
        returns (uint256)
    {
        return _balances[address(this)];
    }

    /*
     * Deposit the selected external reward ERC-20.
     *
     * Example test:
     * 1. Approve this contract in the reward token.
     * 2. Call fundRewards(amount).
     * 3. Holders can call claimRewards().
     */
    function fundRewards(uint256 amount)
        external
    {
        require(
            amount > 0,
            "Reward amount required"
        );

        uint256 eligible =
            rewardEligibleSupply();

        require(
            eligible > 0,
            "No eligible supply"
        );

        uint256 beforeBalance =
            IERC20Reward(rewardToken)
                .balanceOf(address(this));

        _safeTransferFrom(
            rewardToken,
            msg.sender,
            address(this),
            amount
        );

        uint256 afterBalance =
            IERC20Reward(rewardToken)
                .balanceOf(address(this));

        uint256 received =
            afterBalance - beforeBalance;

        require(
            received > 0,
            "No reward received"
        );

        magnifiedRewardPerShare +=
            (received * MAGNITUDE) /
            eligible;

        totalExternalRewardsFunded +=
            received;

        emit RewardsFunded(
            msg.sender,
            received
        );
    }

    function accumulativeRewardOf(
        address account
    )
        public
        view
        returns (uint256)
    {
        if (account == address(this)) {
            return 0;
        }

        int256 magnified =
            int256(
                magnifiedRewardPerShare *
                _balances[account]
            ) +
            magnifiedRewardCorrections[
                account
            ];

        if (magnified <= 0) {
            return 0;
        }

        return
            uint256(magnified) /
            MAGNITUDE;
    }

    function withdrawableRewardOf(
        address account
    )
        public
        view
        returns (uint256)
    {
        uint256 accumulated =
            accumulativeRewardOf(account);

        uint256 alreadyWithdrawn =
            withdrawnRewards[account];

        if (
            accumulated <=
            alreadyWithdrawn
        ) {
            return 0;
        }

        return
            accumulated -
            alreadyWithdrawn;
    }

    function claimRewards()
        external
        returns (uint256)
    {
        require(
            !_claimLock,
            "Claim locked"
        );

        _claimLock = true;

        uint256 amount =
            withdrawableRewardOf(
                msg.sender
            );

        require(
            amount > 0,
            "No reward available"
        );

        withdrawnRewards[msg.sender] +=
            amount;

        totalExternalRewardsClaimed +=
            amount;

        _safeTransfer(
            rewardToken,
            msg.sender,
            amount
        );

        emit RewardClaimed(
            msg.sender,
            amount
        );

        _claimLock = false;

        return amount;
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
            _balances[from] >= amount,
            "Insufficient balance"
        );

        uint256 rewardReserve =
            amount *
            rewardFeeBps /
            10000;

        uint256 liquidityReserve =
            amount *
            liquidityFeeBps /
            10000;

        uint256 projectAmount =
            amount *
            projectFeeBps /
            10000;

        uint256 receivedAmount =
            amount -
            rewardReserve -
            liquidityReserve -
            projectAmount;

        _move(
            from,
            to,
            receivedAmount
        );

        uint256 combinedReserve =
            rewardReserve +
            liquidityReserve;

        if (combinedReserve > 0) {
            _move(
                from,
                address(this),
                combinedReserve
            );

            totalRewardTokenReserved +=
                rewardReserve;

            totalLiquidityTokenReserved +=
                liquidityReserve;
        }

        if (projectAmount > 0) {
            _move(
                from,
                projectWallet,
                projectAmount
            );

            totalProjectFees +=
                projectAmount;
        }

        emit FeesTaken(
            rewardReserve,
            liquidityReserve,
            projectAmount
        );
    }

    /*
     * Preserve previously-earned external rewards
     * when main-token balances move.
     *
     * address(this) is excluded from reward eligibility.
     */
    function _move(
        address from,
        address to,
        uint256 amount
    )
        internal
    {
        if (amount == 0) {
            return;
        }

        _balances[from] -= amount;
        _balances[to] += amount;

        uint256 correction =
            magnifiedRewardPerShare *
            amount;

        if (from != address(this)) {
            magnifiedRewardCorrections[
                from
            ] += int256(correction);
        }

        if (to != address(this)) {
            magnifiedRewardCorrections[
                to
            ] -= int256(correction);
        }

        emit Transfer(
            from,
            to,
            amount
        );
    }

    function _safeTransfer(
        address token,
        address to,
        uint256 amount
    )
        internal
    {
        (bool ok, bytes memory data) =
            token.call(
                abi.encodeWithSelector(
                    IERC20Reward.transfer.selector,
                    to,
                    amount
                )
            );

        require(
            ok &&
            (
                data.length == 0 ||
                abi.decode(data, (bool))
            ),
            "Reward transfer failed"
        );
    }

    function _safeTransferFrom(
        address token,
        address from,
        address to,
        uint256 amount
    )
        internal
    {
        (bool ok, bytes memory data) =
            token.call(
                abi.encodeWithSelector(
                    IERC20Reward.transferFrom.selector,
                    from,
                    to,
                    amount
                )
            );

        require(
            ok &&
            (
                data.length == 0 ||
                abi.decode(data, (bool))
            ),
            "Reward transferFrom failed"
        );
    }
}
