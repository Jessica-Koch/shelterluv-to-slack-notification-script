Add a Slack user to all public channels in the workspace.

Usage: /add-to-slack <SLACK_USER_ID>

Run the following command, substituting the user ID provided by the user:

```bash
node scripts/addUserToAllChannels.js $ARGUMENTS
```

Show the output as it runs. When done, summarize how many channels the user was added to, how many they were already in, and any failures.
