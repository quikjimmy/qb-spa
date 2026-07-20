// Slack sender via chat.postMessage (bot token). Posts to a channel by ID as
// whatever Slack app the bot token belongs to. Deterministic, no LLM in the
// path. The app's only Slack integration.
//
// Never throws: returns { ok, error } so a Slack outage can't take down the
// caller (a background poller). Important: chat.postMessage returns HTTP 200
// even on logical failures (bad channel, not_in_channel, invalid_auth), so we
// must inspect the JSON `ok` field, not just the status code.
//
// `text` renders Slack mrkdwn by default, so `*bold*` and `<url|label>` links
// work.

export interface SlackPostResult { ok: boolean; error?: string }

export async function postSlackMessage(botToken: string, channel: string, text: string): Promise<SlackPostResult> {
  if (!botToken || !channel) return { ok: false, error: 'not_configured' }
  try {
    const r = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: `Bearer ${botToken}`,
      },
      body: JSON.stringify({ channel, text, unfurl_links: false, unfurl_media: false }),
    })
    if (!r.ok) return { ok: false, error: `http_${r.status}` }
    const body = await r.json().catch(() => ({})) as { ok?: boolean; error?: string }
    if (!body.ok) return { ok: false, error: body.error || 'slack_error' }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
