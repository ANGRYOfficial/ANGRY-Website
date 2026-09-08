use anchor_lang::prelude::*;

pub const CONFIG_SEED: &[u8] = b"angry-engine-config";
pub const VAULT_SEED: &[u8] = b"angry-engine-vault";
pub const BUYBACK_AUTHORITY_SEED: &[u8] = b"angry-engine-buyback";

pub const BPS_DENOMINATOR: u16 = 10_000;
pub const ENGINE_VERSION: u8 = 1;

// PumpSwap AMM (same program ID on Devnet/Mainnet).
pub const PUMPSWAP_PROGRAM_ID: Pubkey = Pubkey::new_from_array([
    12, 20, 222, 252, 130, 94, 198, 118,
    148, 37, 8, 24, 187, 101, 64, 101,
    244, 41, 141, 49, 86, 213, 113, 180,
    212, 248, 9, 12, 24, 233, 168, 99,
]);

pub const PUMP_FEE_PROGRAM_ID: Pubkey = Pubkey::new_from_array([
    12, 53, 255, 169, 5, 90, 142, 86,
    141, 168, 247, 188, 7, 86, 21, 39,
    76, 241, 201, 44, 164, 31, 64, 0,
    156, 81, 106, 164, 20, 194, 124, 112,
]);

pub const WSOL_MINT: Pubkey = Pubkey::new_from_array([
    6, 155, 136, 87, 254, 171, 129, 132,
    251, 104, 127, 99, 70, 24, 192, 53,
    218, 196, 57, 220, 26, 235, 59, 85,
    152, 160, 240, 0, 0, 0, 0, 1,
]);

// Anchor discriminator for PumpSwap Pool accounts.
pub const PUMPSWAP_POOL_DISCRIMINATOR: [u8; 8] = [
    241, 154, 109, 4, 17, 177, 109, 188,
];

// PumpSwap buy_exact_quote_in discriminator.
pub const PUMPSWAP_BUY_EXACT_QUOTE_IN_DISCRIMINATOR: [u8; 8] = [
    198, 46, 21, 82, 180, 217, 232, 112,
];

// Official breaking fee recipients announced by Pump for the April 2026 AMM upgrade.
pub const PUMPSWAP_BREAKING_FEE_RECIPIENTS: [Pubkey; 8] = [
    Pubkey::new_from_array([
        67, 158, 101, 16, 192, 61, 101, 250,
        217, 49, 232, 157, 4, 190, 11, 183,
        13, 81, 151, 31, 81, 196, 21, 251,
        52, 76, 7, 219, 65, 159, 33, 34,
    ]),
    Pubkey::new_from_array([
        2, 35, 85, 22, 169, 23, 19, 76,
        103, 88, 140, 73, 56, 32, 174, 21,
        94, 233, 102, 101, 87, 122, 193, 183,
        24, 218, 71, 221, 207, 42, 5, 14,
    ]),
    Pubkey::new_from_array([
        230, 167, 226, 32, 104, 187, 136, 100,
        10, 165, 127, 144, 147, 8, 198, 31,
        239, 113, 26, 1, 99, 245, 167, 85,
        192, 112, 188, 134, 13, 31, 99, 103,
    ]),
    Pubkey::new_from_array([
        32, 124, 236, 218, 91, 204, 108, 177,
        234, 240, 241, 109, 104, 64, 69, 102,
        177, 141, 86, 210, 72, 26, 203, 49,
        112, 50, 101, 110, 144, 85, 28, 120,
    ]),
    Pubkey::new_from_array([
        68, 150, 65, 248, 73, 88, 220, 115,
        167, 106, 133, 216, 117, 111, 85, 192,
        44, 218, 202, 137, 186, 25, 50, 121,
        12, 54, 138, 177, 87, 233, 45, 115,
    ]),
    Pubkey::new_from_array([
        197, 75, 150, 181, 201, 49, 148, 30,
        70, 234, 75, 226, 224, 227, 17, 39,
        116, 79, 198, 183, 76, 251, 69, 94,
        254, 175, 139, 213, 113, 121, 44, 237,
    ]),
    Pubkey::new_from_array([
        68, 252, 31, 120, 249, 74, 51, 208,
        144, 156, 94, 107, 95, 176, 33, 87,
        10, 216, 219, 173, 141, 232, 253, 179,
        210, 14, 209, 205, 153, 235, 142, 78,
    ]),
    Pubkey::new_from_array([
        135, 112, 21, 126, 235, 235, 103, 138,
        101, 93, 185, 155, 55, 246, 177, 50,
        108, 118, 87, 219, 144, 207, 184, 168,
        122, 190, 248, 199, 182, 242, 200, 105,
    ]),
];
