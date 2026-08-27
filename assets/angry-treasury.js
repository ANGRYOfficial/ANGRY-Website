/*
  ANGRY Creator Treasury Configuration

  IMPORTANT:
  - Public treasury addresses only.
  - Never place seed phrases or private keys here.
  - Payments remain disabled until atomic payment contracts are tested.
*/

window.ANGRY_PAYMENT_CONFIG = Object.freeze({
  paymentsEnabled: false,

  treasury: {
    evm: "0x1479d63c37445bB4dCE7a3833809FDAB3A7E272A",
    solana: "Eim2rfS3Q1qJj3ZRAkPpTJRvAEumnGrE2MSeFgTRngPz"
  },

  networks: {
    ethereum: {
      native: "ETH",
      treasury: "evm"
    },

    base: {
      native: "ETH",
      treasury: "evm"
    },

    robinhood: {
      native: "ETH",
      treasury: "evm"
    },

    arbitrum: {
      native: "ETH",
      treasury: "evm"
    },

    bsc: {
      native: "BNB",
      treasury: "evm"
    },

    polygon: {
      native: "POL",
      treasury: "evm"
    },

    solana: {
      native: "SOL",
      treasury: "solana"
    }
  }
});
