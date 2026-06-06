# Data Sync Utility

Internal utility for tracking and synchronizing event scheduling and live item stats using automated pipelines.

## Components

- **Schedule Indexer (`bid-announce-sync.cjs`)**: Scrapes upcoming and active batch schedules to index station metadata and timeline parameters. Recommended interval: twice daily.
- **Live State Tracker (`bidding-plates-sync.cjs`)**: Scrapes live metrics and values for items in active batches. Monitors value updates and dispatches notifications if changes exceed limits. Recommended interval: every 30 minutes.
- **Batch Processor (`gh-plate-sync.cjs`)**: Updates static inventory databases.

## Usage
Scheduled execution is configured via CI/CD actions (`.github/workflows/`).
Requires environment configurations in `.env` for storage endpoint and notification keys.