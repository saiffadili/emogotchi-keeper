# Emogotchi Keeper

This private GitHub Actions bot keeps Emogotchi #25287 alive with the minimum practical care plan.

- Requests an on-chain starvation check every 30 minutes.
- Feeds when 24 hours or less remain, approximately once per day.
- Pays exactly 1 MON per feed.
- Never washes, plays, cleans, sleeps, names, transfers, or revives the cat.
- Stops safely if the configured wallet is not the NFT owner, the cat is dead, the chain is wrong, or the balance is insufficient.

## Security model

Use a dedicated wallet containing only this NFT and enough MON for feeding. Anyone who obtains that wallet's private key can steal both the NFT and its MON.

Never commit a private key to this repository. Never send the key in chat. Store it only as the encrypted repository secret described below.

## One-time setup

1. Create a dedicated EVM wallet and securely back up its recovery phrase offline.
2. Transfer Emogotchi #25287 to that wallet. The cat's existing state moves with the NFT.
3. Fund the dedicated wallet with approximately 380 MON for one year of feeding and gas.
4. In this GitHub repository, open **Settings → Secrets and variables → Actions → New repository secret**.
5. Name the secret `EMOGOTCHI_PRIVATE_KEY` and enter the dedicated wallet's private key, including the `0x` prefix.
6. Open **Actions → Keep Emogotchi Alive → Run workflow**. Leave **dry_run** enabled for the first test.
7. Check that the log reports the correct cat, owner, balance, and time remaining.
8. The 30-minute schedule will then run automatically. Scheduled runs use live mode but only feed when 24 hours or less remain.

## Optional one-time live feed test

To verify a real transaction before the four-hour window:

1. Open **Actions → Keep Emogotchi Alive → Run workflow**.
2. Clear **Check everything without sending MON**.
3. Select **TEST ONLY: spend 1 MON and feed now**.
4. Run the workflow and confirm that the log contains a MonadScan transaction link and a new deadline.

This deliberately spends 1 MON plus gas and resets the starvation deadline. The force option is off by default and is ignored by scheduled runs.

## Telegram alerts

Add these encrypted repository secrets to enable notifications:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`

The bot sends:

- A fun daily status around 18:17 UTC with the deadline, stats, and wallet balance.
- A detailed confirmation and MonadScan link after every successful feed.
- An advance warning when 26 hours or less remain but it is not yet time to feed.
- A safety alert with the reason and GitHub log link if the keeper stops.
- One daily paused reminder while the cat is dead; automatic feeding resumes after a manual revival.
- A status message whenever a manual dry run succeeds.

The Telegram token is scoped only to the keeper step. The wallet private key is also no longer exposed to checkout or dependency-installation steps.

Changes to the keeper code automatically trigger a dry run. These verification runs read the live cat state and send a Telegram test result but never submit a feed transaction.

## Expected cost

With a 24-hour safety margin, a feed occurs approximately every 24 hours:

- About 365.25 MON per year in feed payments.
- Network gas is additional.
- Keeping about 380 MON available provides a reasonable annual operating balance at recent gas levels.

## Configuration

The workflow defines:

- `CAT_ID=25287`
- `FEED_THRESHOLD_HOURS=24`
- `WARNING_THRESHOLD_HOURS=26`
- `RPC_URL=https://rpc1.monad.xyz`

Increasing `FEED_THRESHOLD_HOURS` feeds earlier and costs slightly more, but provides more protection against service or network outages. GitHub scheduled runs can still be delayed or dropped, so this remains a best-effort keeper rather than a hard availability guarantee.

The 30-minute schedule uses about 1,440 billable GitHub Actions minutes in a 30-day month because private-repository jobs round up to one minute. That fits inside the 2,000-minute monthly allowance on GitHub Free if the account is not using those minutes for other private workflows.

## Emergency checks

- GitHub Actions must remain enabled.
- The repository should remain private.
- Review the workflow at least occasionally and enable GitHub notifications for failed workflow runs.
- If the bot reports that the cat is dead, it deliberately stops rather than spending 1,000 MON on an automatic revival.
