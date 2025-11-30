const SHELTERLUV_API_KEY = process.env.SHELTERLUV_API_KEY;
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;

if (!SHELTERLUV_API_KEY) {
  console.error('Missing SHELTERLUV_API_KEY env var');
}

if (!SHELTERLUV_API_KEY || !SLACK_WEBHOOK_URL) {
  console.error('Missing SLACK_WEBHOOK_URL env var');
}

if (!SHELTERLUV_API_KEY || !SLACK_WEBHOOK_URL) {
  process.exit(1);
}

async function main() {
  console.log('Running vaccine check...');

  const res = await fetch(SLACK_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: 'Test: Vaccine check ran successfully with pnpm',
    }),
  });

  if (!res.ok) {
    console.error(
      'Failed to send Slack message:',
      res.status,
      await res.text()
    );
    process.exit(1);
  }

  console.log('Slack test message sent.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
