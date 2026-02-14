# Slow Mode Extension - Changelog

## 2026-02-13 - Manual Editing Support

### Added
- **Manual editing of staged content**: When reviewing write/edit operations with Ctrl+O, you can now edit the staged files in your external editor
- **Content update tracking**: The extension tracks which tool calls had their content modified
- **Visual feedback**: 
  - Notification when edited content is detected: "Using edited content"
  - Note appended to tool results showing content was modified with line diff stats
  - UI hint changes from "view externally" to "edit externally" when editing is enabled
- **Live preview updates**: After editing in external editor, the review UI automatically reloads and displays the updated content/diff

### How It Works

1. **Review Phase**: Slow mode intercepts write/edit tool calls and stages content in `/tmp/pi-slow-mode-*/`
2. **External Editing**: Press Ctrl+O to open staged files in your `$EDITOR` or diff viewer
3. **Content Reload**: After saving and closing the editor, the UI reloads the modified content
4. **Approval**: Review the changes and press Enter to approve or Esc to reject
5. **Execution**: The actual write/edit operation uses your edited content, not the LLM's original proposal

### What Gets Updated

✅ **Actual file content**: The write/edit tool uses your edited content  
✅ **Tool result note**: Shows that content was modified with line count change  
✅ **Review UI**: Displays updated content/diff after external editing  
❌ **Collapsed snippet**: Still shows original LLM proposal (by design)

### Why the Snippet Shows Original Content

The collapsed snippet (what you see with "ctrl+o to expand") shows the LLM's original proposal, not your edited version. This is **intentional** because:
- It preserves a record of what the LLM proposed vs. what was actually applied
- The snippet is rendered before interception happens (technical limitation)
- You can see the actual content that was written by:
  - Reading the tool result note (shows modification happened)
  - Expanding the snippet to see the full original
  - Checking the actual file that was written
  - Looking at the review UI which shows updated content

### Example

```
LLM proposes: "Hello, World!" (shown in snippet)
              ↓
You edit to: "Hello, Universe!" (in external editor)
              ↓
File written: "Hello, Universe!" (actual content)
              ↓
Result shows: "Note: Content was modified in slow mode review before writing (+0 lines)."
```

### Technical Details

- **Tracking**: Uses a Map<toolCallId, {original, edited}> to track modifications
- **Content mutation**: Modifies the `input.content` / `input.newText` parameters directly
- **Event flow**: tool_call (intercept) → review → modify input → tool executes → tool_result (annotate)
- **Cleanup**: Edited call tracking is cleaned up immediately after tool result is processed
