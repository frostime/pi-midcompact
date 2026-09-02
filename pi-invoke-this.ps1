# Dev launcher: loads the extension from source plus the debug preview
# extension (dev/midcompact-debug-ui.ts — never part of the production install).
pi -e ".\src\index.ts" -e ".\dev\midcompact-debug-ui.ts" --skill ".\skills\midcompact" $args
