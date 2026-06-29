2026-06-29
- Changed top user rendering to show plain escaped display names without @mentions or profile links.
- Added clickable display-name mentions in other HTML-rendered user references.
- Files: src/utils/text.ts, src/bot/screens.ts, src/bot/handlers.ts, tests/test_text_formatting.py.
- Reason: avoid notification spam from public chat top messages while keeping profile links elsewhere.
