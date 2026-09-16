# Emogotchi Keeper

This private GitHub Actions bot keeps Emogotchi #69869 alive with the minimum practical care plan.

- Checks the on-chain starvation deadline once per hour.
- Feeds only when four hours or less remain.
- Pays exactly 1 MON per feed.
- Never washes, plays, cleans, sleeps, names, transfers, or revives the cat.
- Stops safely if the configured wallet is not the NFT owner, the cat is dead, the chain is wrong, or the balance is insufficient.

## Security model

Use a dedicated wallet containing only this NFT and enough MON for feeding. Anyone who obtains that wallet's private key can steal both the NFT and its MON.

Never commit a private key to this repository. Never send the key in chat. Store it only as the encrypted repository secret described below.

## One-time setup

1. Create a dedicated EVM wallet and securely back up its recovery phrase offline.
2. Transfer Emogotchi #69869 to that wallet. The cat's existing state moves with the NFT.
3. Fund the dedicated wallet with approximately 210 MON for one year of feeding and gas.
4. In this GitHub repository, open **Settings → Secrets and variables → Actions → New repository secret**.
5. Name the secret `EMOGOTCHI_PRIVATE_KEY` and enter the dedicated wallet's private key, including the `0x` prefix.
6. Open **Actions → Keep Emogotchi Alive → Run workflow**. Leave **dry_run** enabled for the first test.
7. Check that the log reports the correct cat, owner, balance, and time remaining.
8. The hourly schedule will then run automatically. Scheduled runs use live mode but only feed inside the four-hour window.

## Optional one-time live feed test

To verify a real transaction before the four-hour window:

1. Open **Actions → Keep Emogotchi Alive → Run workflow**.
2. Clear **Check everything without sending MON**.
3. Select **TEST ONLY: spend 1 MON and feed now**.
4. Run the workflow and confirm that the log contains a MonadScan transaction link and a new deadline.

This deliberately spends 1 MON plus gas and resets the starvation deadline. The force option is off by default and is ignored by scheduled runs.

## Expected cost

With a four-hour safety margin, a feed occurs approximately every 44 hours:

- About 199.1 MON per year in feed payments.
- Network gas is additional.
- Keeping about 210 MON available provides a reasonable annual operating balance at recent gas levels.

## Configuration

The workflow defines:

- `CAT_ID=69869`
- `FEED_THRESHOLD_HOURS=4`
- `RPC_URL=https://rpc1.monad.xyz`

Increasing `FEED_THRESHOLD_HOURS` feeds earlier and costs slightly more, but provides more protection against service or network outages.

## Emergency checks

- GitHub Actions must remain enabled.
- The repository should remain private.
- Review the workflow at least occasionally and enable GitHub notifications for failed workflow runs.
- If the bot reports that the cat is dead, it deliberately stops rather than spending 1,000 MON on an automatic revival.
