// supabaseBridge.js
// Connects this Node backend to the SAME Supabase project support.html
// already uses. It listens for new visitor messages on `support_messages`
// and writes the AI's reply back into that table as a normal row — so
// support.html's existing Realtime subscription renders it exactly like
// a human admin reply, with zero front-end changes required.
//
// Requires a SERVICE ROLE key (not the anon key from support.html),
// because it needs to read/write across all threads, not just one.

const { createClient } = require('@supabase/supabase-js');
const { handleMessage } = require('./ai');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const AI_SENDER = process.env.AI_SENDER_LABEL || 'ai'; // stored in the `sender` column

// How long to wait before the AI replies, in case a human admin is
// already typing a response in the admin console. If a human reply lands
// in that window, the AI stands down for that message.
const REPLY_DELAY_MS = Number(process.env.AI_REPLY_DELAY_MS || 3000);

function assertConfigured() {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    throw new Error(
      'supabaseBridge.js: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env. ' +
      'Get the service role key from Supabase Dashboard -> Project Settings -> API. ' +
      'Never expose this key to the browser.'
    );
  }
}

async function humanRepliedSince(sb, threadId, sinceIso) {
  const { data, error } = await sb
    .from('support_messages')
    .select('id, sender, created_at')
    .eq('thread_id', threadId)
    .neq('sender', 'visitor')
    .neq('sender', AI_SENDER)
    .gt('created_at', sinceIso)
    .limit(1);
  if (error) {
    console.warn('supabaseBridge: humanRepliedSince check failed, proceeding anyway:', error.message);
    return false;
  }
  return (data || []).length > 0;
}

function startSupabaseBridge() {
  assertConfigured();
  const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  const channel = sb
    .channel('ai-bridge-support-messages')
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'support_messages' },
      async (payload) => {
        const row = payload.new;
        if (row.sender !== 'visitor') return; // only react to visitor messages

        const threadId = row.thread_id;
        const receivedAt = row.created_at;

        try {
          // Give a human admin a short window to jump in first.
          await new Promise((resolve) => setTimeout(resolve, REPLY_DELAY_MS));

          if (await humanRepliedSince(sb, threadId, receivedAt)) {
            console.log(`supabaseBridge: human already replied in thread ${threadId}, AI standing down`);
            return;
          }

          const result = await handleMessage({ sessionId: threadId, message: row.message });

          const { error } = await sb.from('support_messages').insert({
            thread_id: threadId,
            sender: AI_SENDER,
            message: result.reply,
          });
          if (error) throw error;

          console.log(`supabaseBridge: AI replied in thread ${threadId} (intent: ${result.intent})`);
        } catch (err) {
          console.error(`supabaseBridge: failed to handle message in thread ${threadId}:`, err);
        }
      }
    )
    .subscribe((status) => {
      console.log(`supabaseBridge: realtime channel status = ${status}`);
    });

  return channel;
}

module.exports = { startSupabaseBridge };
