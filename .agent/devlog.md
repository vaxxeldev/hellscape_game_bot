2026-06-29
- Changed top user rendering to show plain escaped display names without @mentions or profile links.
- Added clickable display-name mentions in other HTML-rendered user references.
- Files: src/utils/text.ts, src/bot/screens.ts, src/bot/handlers.ts, tests/test_text_formatting.py.
- Reason: avoid notification spam from public chat top messages while keeping profile links elsewhere.

2026-06-29
- Added admin-specific back navigation for admin stats and reviewed purchase screens.
- Files: src/bot/keyboards.ts, src/bot/handlers.ts.
- Reason: keep admin flows returning to the admin panel instead of the regular /start home screen.
