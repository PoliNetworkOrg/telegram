# UI Admin Actions Tracking

This feature tracks administrative actions performed via Telegram's UI (not via bot commands) and logs them to the appropriate log channels.

## Implemented Features

### ✅ Supported Actions
- **Ban/Unban**: Detects when users are banned or unbanned via admin panel or right-click menu
- **Mute/Unmute**: Detects when users are muted or unmuted via admin panel  
- **Kick**: Detects when users are kicked (temporary bans) via admin panel

### ✅ Anti-Double-Logging
- Prevents duplicate logging when actions are performed via bot commands
- Uses a temporary tracking system to identify command-initiated actions

### ✅ Integration
- Uses existing TgLogger infrastructure
- Logs to the same `adminActions` topic as command-based actions
- Follows existing message formatting conventions

## How It Works

1. **Chat Member Updates**: The bot listens for `chat_member` and `my_chat_member` updates from Telegram
2. **Status Change Detection**: Analyzes changes in user status and permissions
3. **Command Action Filtering**: Skips logging if the action was initiated by a bot command
4. **Logging**: Uses the existing TgLogger to send formatted messages to log channels

## Limitations

### ❌ Message Deletion Detection
- Telegram Bot API doesn't provide message deletion events
- Would require admin permissions and complex workarounds
- Currently not implemented due to API constraints

### ❌ Limited Action Details  
- UI actions don't include duration or reason information
- Only basic action type can be detected

## Testing

The feature includes comprehensive unit tests covering:
- Command action marking and detection
- Mute status detection  
- Kick vs ban differentiation
- Edge case handling

Run tests with:
```bash
npm run test
```

## Configuration

No additional configuration required. The feature automatically:
- Integrates with existing TgLogger setup
- Uses configured log channel and topics
- Follows existing middleware patterns

## Usage Examples

When an admin bans a user via Telegram's UI:
```
🚫 Ban
Target: @username (123456789)
Group: Example Group
Admin: @admin_user (987654321)
```

When an admin mutes a user via Telegram's UI:
```
🤫 Mute  
Target: @username (123456789)
Group: Example Group
Admin: @admin_user (987654321)
```

## Technical Implementation

- **File**: `src/middlewares/ui-admin-actions.ts`
- **Integration**: Added to bot middleware stack in `src/bot.ts`
- **Dependencies**: Uses existing TgLogger, no new dependencies
- **Performance**: Minimal overhead, only processes relevant updates