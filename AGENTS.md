# Rep Journal

- Trace vault operations through both entry points. Obsidian can hide workout JSON from its file index, and the standalone server reads the same journal through Node. Keep record parsing, ordering, and plan matching shared. Keep filesystem access and event subscriptions in the host adapters.
- When optimizing a save or a picker, measure it through the adapter or HTTP endpoint. Count file-body reads and metadata calls separately. For caches, exercise a second unchanged request and an external edit. For automatic CSV, compare the saved bytes with `toCsv` from a fresh ledger, including a failed or overlapping refresh.
- Keep navigation and screen disposal in `mountJournal`. Give an extracted screen the operations it uses, and check what happens if the user navigates away or edits a draft while a request is pending.
- The standalone server, import CLI, and unit tests run TypeScript directly in Node. Use erasable TypeScript syntax in their import graphs and exercise the Node entry point when moving code shared with the bundled plugin.
