# Upgrade to Mnemosyne 2

An upgrade should preserve the memory you already depend on. Evaluate the selected release against a separate copy or new local database before changing a live application's storage path. The current local runtime requires Node 22.16 or later. Source changes, a website deployment and a published package release are separate events.

## Runtime and package

The local API provides scoped capture, recall, source correction, history and forgetting. Existing backend APIs remain distinct integrations; creating a local engine does not move their data. Keep deployment-specific collection and volume identities unchanged unless you are deliberately performing a migration.

## Local trust and lifecycle

The local engine distinguishes untrusted, observed and controller-verified records. Importing a record does not authenticate it or certify its truth. Corrections retain inspectable history while withholding obsolete advice; privacy erasure removes live source content and dependents. A snapshot preserves only the deletion state known when it was created.

## Choose an adoption path

Use [Gradual Migration](/docs/reference/BRIDGE.html) to stay connected to your old search, [Full Migration](/docs/reference/MIGRATION.html) for an explicit export transfer, and [Recovery](/docs/reference/OPERATIONS.html) for complete database backups. Test your own host loop and retained data before choosing a cutover.
