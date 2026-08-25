ANGRY Unified Website v1.0
==========================

This package combines the current ANGRY project into one website:

/index.html                 Home
/tracker/index.html         ANGRY Tracker (from the uploaded latest tracker file)
/token-creator/index.html   ANGRY Token Creator Beta v0.6.3
/nft-creator/index.html     ANGRY NFT Creator Beta v0.6.4
/docs/index.html            Unified documentation
/assets/ecosystem.css       Shared ecosystem navigation styles

Important
---------
1. Upload the CONTENTS of this folder to the web repository root.
2. Keep the folder names unchanged unless you also update the relative links.
3. The Tracker analysis code was preserved; the main changes are unified navigation, product-focused hero copy, and removal of the missing angry-logo.png dependency.
4. Token Creator:
   - Ethereum Sepolia: Standard test deploy enabled
   - Base Sepolia: Standard test deploy enabled
   - Robinhood Chain Testnet: Standard test deploy enabled
   - Solana: visible as Coming soon because it needs a separate SPL Token + Solana wallet path
   - Liquidity / Reward remain planner-only
5. NFT Creator:
   - Initial selectable purposes: 1 of 1, Collection, Multiple Editions
   - Live NFT deployment is not enabled yet
   - Solana remains Coming soon for the Solana-specific NFT engine
6. Do not put secret API keys or wallet private keys into static HTML / JavaScript.
7. Test all wallet and RPC flows on testnet before any mainnet release.

GitHub Pages
------------
If this is uploaded to the root of a GitHub Pages repository, index.html will be the landing page.
The product folders will work as separate pages under the same website.

Example:
  /tracker/
  /token-creator/
  /nft-creator/
  /docs/
